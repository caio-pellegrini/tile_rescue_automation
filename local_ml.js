const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const sharp = require('sharp');

const DEFAULT_MODEL = process.env.LOCAL_VISION_MODEL || 'Xenova/clip-vit-base-patch32';
const DEFAULT_THRESHOLD = Number(process.env.LOCAL_VISION_THRESHOLD || 0.88);
const PARTIAL_REFERENCE_THRESHOLD = Number(process.env.LOCAL_VISION_PARTIAL_THRESHOLD || 0.80);
const PARTIAL_MIN_VISIBLE_FRACTION = 0.45;
const PARTIAL_MIN_MARGIN = 0.01;
const PARTIAL_STRONG_COVER_MARGIN = 0.005;
const PARTIAL_CONFIRMED_PEERS = 2;
const PARTIAL_REFERENCE_CANDIDATE_LIMIT = Number(process.env.LOCAL_VISION_PARTIAL_CANDIDATES || 8);
const DEFAULT_LIBRARY_DIR = process.env.LOCAL_VISION_LIBRARY || path.resolve('icon-library');
const CATALOG_FILE = 'catalog.json';
const MASK_BACKGROUND = '#149b7d';
const TILE_EMBEDDING_CACHE_LIMIT = 256;
const PARTIAL_EMBEDDING_CACHE_LIMIT = 512;

function cacheGet(cache, key) {
  if (!cache || !cache.has(key)) return null;
  const value = cache.get(key);
  // Refresh insertion order so the bounded map behaves as an LRU cache.
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function cacheSet(cache, key, value, limit) {
  if (!cache) return;
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value);
}

function referenceKey(reference) {
  return `${reference.filePath}|${reference.variant || ''}`;
}

async function fileFingerprint(filePath) {
  const data = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function recordTiming(timing, key, startedAt) {
  if (!timing) return;
  const elapsed = performance.now() - startedAt;
  timing[key] = Number(((timing[key] || 0) + elapsed).toFixed(3));
}

function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function normalize(values) {
  const norm = Math.hypot(...values) || 1;
  return values.map(value => value / norm);
}

async function loadExtractor(model = DEFAULT_MODEL) {
  const { pipeline } = await import('@huggingface/transformers');
  return pipeline('image-feature-extraction', model, { dtype: 'q8' });
}

async function embedPaths(extractor, paths) {
  if (!paths.length) return [];
  const output = await extractor(paths, { pooling: 'mean' });
  const dimensions = output.dims[output.dims.length - 1];
  const vectors = [];
  for (let i = 0; i < paths.length; i++) {
    vectors.push(normalize(Array.from(output.data.slice(i * dimensions, (i + 1) * dimensions))));
  }
  return vectors;
}

function coverRect(cover) {
  return {
    left: Math.round(cover.cx - 71),
    top: Math.round(cover.cy - 80),
    width: 142,
    height: 160,
  };
}

function intersection(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

function visibleMaskSvg(box, covers, outputWidth = box.width, outputHeight = box.height) {
  const scaleX = outputWidth / box.width;
  const scaleY = outputHeight / box.height;
  const rects = (covers || [])
    .map(cover => intersection(box, coverRect(cover)))
    .filter(Boolean)
    .map(rect => `<rect x="${(rect.left - box.left) * scaleX}" y="${(rect.top - box.top) * scaleY}" width="${rect.width * scaleX}" height="${rect.height * scaleY}" fill="${MASK_BACKGROUND}"/>`)
    .join('');
  return Buffer.from(`<svg width="${outputWidth}" height="${outputHeight}"><g>${rects}</g></svg>`);
}

async function buildPartialReferencePaths(
  packetDir,
  hiddenTiles,
  references,
  timing = null,
  fileCache = null,
  allowedReferenceKeys = null,
) {
  const variantDir = path.join(packetDir, 'reference-variants');
  const entries = [];
  let created = 0;
  for (const tile of hiddenTiles) {
    const variants = tile.visibleVariants?.length
      ? tile.visibleVariants
      : (tile.visibleCrop && (tile.maskedBy || tile.coveredBy || []).length
        ? [{
          key: 'primary',
          crop: tile.visibleCrop,
          cover: (tile.maskedBy || tile.coveredBy)[0],
        }]
        : []);
    if (!variants.length || !tile.box) continue;
    await fs.mkdir(variantDir, { recursive: true });
    for (const visibleVariant of variants) {
      if (!visibleVariant.cover) continue;
      const variantKey = `${tile.id}::${visibleVariant.key}`;
      const allowed = allowedReferenceKeys?.get(variantKey) || null;
      for (const reference of references) {
        if (allowed && !allowed.has(referenceKey(reference))) continue;
        const maskKey = [
          reference.filePath,
          reference.variant || '',
          visibleVariant.cover.cx - tile.box.left,
          visibleVariant.cover.cy - tile.box.top,
          tile.box.width,
          tile.box.height,
        ].join('|');
        const safeId = `${tile.id}--${visibleVariant.key}--${reference.label}--${reference.variant || 'default'}`
          .replace(/[^a-z0-9_.-]+/gi, '_');
        let outputPath = cacheGet(fileCache, maskKey);
        if (outputPath) {
          try {
            await fs.access(outputPath);
            if (timing) timing.partialReferenceCacheHits = (timing.partialReferenceCacheHits || 0) + 1;
          } catch {
            outputPath = null;
          }
        }
        if (!outputPath) {
          outputPath = path.join(variantDir, `${safeId}.png`);
          const readStartedAt = performance.now();
          const referenceBuffer = await fs.readFile(reference.filePath);
          recordTiming(timing, 'fileReadMs', readStartedAt);
          const referenceMetadata = await sharp(referenceBuffer).metadata();
          const transformStartedAt = performance.now();
          await sharp(referenceBuffer)
            .composite([{
              input: visibleMaskSvg(
                tile.box,
                [visibleVariant.cover],
                referenceMetadata.width || tile.box.width,
                referenceMetadata.height || tile.box.height,
              ),
              left: 0,
              top: 0,
            }])
            .png()
            .toFile(outputPath);
          recordTiming(timing, 'partialReferenceGenerationMs', transformStartedAt);
          cacheSet(fileCache, maskKey, outputPath, PARTIAL_EMBEDDING_CACHE_LIMIT);
        }
        entries.push({
          ...reference,
          filePath: outputPath,
          cacheKey: maskKey,
          view: 'masked-visible',
          tileId: tile.id,
          visibleVariantKey: visibleVariant.key,
          selectedCover: visibleVariant.cover,
        });
        created++;
      }
    }
  }
  return { entries, created, variantDir: created ? 'reference-variants/' : null };
}

async function loadCatalog(libraryDir = DEFAULT_LIBRARY_DIR) {
  const catalogPath = path.join(libraryDir, CATALOG_FILE);
  try {
    const parsed = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
    return { schemaVersion: parsed.schemaVersion || 1, icons: parsed.icons || {} };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { schemaVersion: 1, icons: {} };
  }
}

function referenceEntries(catalog) {
  return Object.entries(catalog.icons || {}).flatMap(([label, entries]) =>
    (Array.isArray(entries) ? entries : []).map(entry => ({ label, ...entry })));
}

async function existingReferenceEntries(catalog, libraryDir) {
  const entries = [];
  const missing = [];
  for (const entry of referenceEntries(catalog)) {
    const filePath = path.resolve(libraryDir, entry.file);
    try {
      await fs.access(filePath);
      entries.push({ ...entry, filePath });
    } catch {
      missing.push({ label: entry.label, file: entry.file });
    }
  }
  return { entries, missing };
}

function groupEmbeddings(tiles, embeddings, threshold = DEFAULT_THRESHOLD) {
  const order = tiles
    .map((tile, index) => ({ tile, index }))
    .sort((a, b) => {
      const visibilityA = a.tile.visibility ?? (a.tile.role === 'board' ? 1 : 0);
      const visibilityB = b.tile.visibility ?? (b.tile.role === 'board' ? 1 : 0);
      return visibilityB - visibilityA;
    });

  const groups = [];
  const assigned = new Map();
  for (const { tile, index } of order) {
    let best = null;
    for (const group of groups) {
      const similarity = cosine(embeddings[index], group.prototype);
      if (!best || similarity > best.similarity) best = { group, similarity };
    }
    if (!best || best.similarity < threshold) {
      const group = {
        groupId: `unlabeled-group-${groups.length + 1}`,
        prototype: embeddings[index],
        members: [],
      };
      groups.push(group);
      best = { group, similarity: 1 };
    }

    best.group.members.push(tile.id);
    if (tile.role !== 'hidden' || (tile.visibility || 0) > 0.75) {
      best.group.prototype = normalize(best.group.prototype.map((value, i) =>
        value * 0.8 + embeddings[index][i] * 0.2));
    }
    assigned.set(tile.id, { group: best.group, similarity: best.similarity });
  }

  const predictions = tiles.map((tile, index) => {
    const result = assigned.get(tile.id);
    const alternatives = groups
      .map(group => ({ label: group.groupId, confidence: cosine(embeddings[index], group.prototype) }))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(1, 3)
      .map(item => ({ label: item.label, confidence: Number(item.confidence.toFixed(4)) }));
    return {
      id: tile.id,
      label: 'unknown',
      groupId: result.group.groupId,
      confidence: Number(Math.max(0, Math.min(1, result.similarity)).toFixed(4)),
      visibleFraction: tile.role === 'hidden' ? Number((tile.visibility || 0).toFixed(3)) : 1,
      alternatives,
    };
  });
  return { predictions, groups: groups.map(({ groupId, members }) => ({ groupId, members })) };
}

async function prepareClassifier(options = {}) {
  const model = options.model || DEFAULT_MODEL;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const libraryDir = options.libraryDir || DEFAULT_LIBRARY_DIR;
  const catalog = await loadCatalog(libraryDir);
  const references = await existingReferenceEntries(catalog, libraryDir);
  const extractor = references.entries.length ? await loadExtractor(model) : null;
  let referenceEmbeddings = [];
  if (extractor && references.entries.length) {
    referenceEmbeddings = await embedPaths(extractor, references.entries.map(entry => entry.filePath));
  }
  return {
    model,
    threshold,
    libraryDir,
    catalog,
    references,
    extractor,
    partialReferenceEmbeddings: new Map(),
    partialReferenceFiles: new Map(),
    tileEmbeddings: new Map(),
    referencePrototypes: references.entries.map((entry, index) => ({
      label: entry.label,
      variant: entry.variant || null,
      file: entry.file,
      filePath: entry.filePath,
      prototype: referenceEmbeddings[index],
    })),
  };
}

async function classifyPacketWithResources(packetDir, resources, timing = null, options = {}) {
  const classifyStartedAt = performance.now();
  const manifestReadStartedAt = performance.now();
  const manifest = JSON.parse(await fs.readFile(path.join(packetDir, 'manifest.json'), 'utf8'));
  recordTiming(timing, 'fileReadMs', manifestReadStartedAt);
  const tiles = (manifest.tiles || []).filter(tile =>
    options.classifyHidden !== false || tile.role !== 'hidden');
  const {
    model,
    threshold,
    libraryDir,
    references,
    extractor,
    referencePrototypes,
  } = resources;
  if (!tiles.length) {
    recordTiming(timing, 'totalMs', classifyStartedAt);
    return { model, threshold, libraryDir, referenceCount: references.entries.length, predictions: [], groups: [], timing };
  }

  if (!extractor || !referencePrototypes.length) {
    recordTiming(timing, 'totalMs', classifyStartedAt);
    return {
      model,
      threshold,
      libraryDir,
      referenceCount: 0,
      missingReferences: references.missing,
      tileCount: tiles.length,
      inferenceMs: 0,
      predictions: tiles.map(tile => ({
        id: tile.id,
        label: 'unknown',
        groupId: `unlabeled-group-${tile.id}`,
        confidence: 0,
        visibleFraction: tile.role === 'hidden' ? Number((tile.visibility || 0).toFixed(3)) : 1,
        alternatives: [],
      })),
      groups: [],
      timing,
    };
  }

  const tileInputs = [];
  for (const tile of tiles) {
    const variants = tile.role === 'hidden' && tile.visibleVariants?.length
      ? tile.visibleVariants
      : [{
        key: null,
        crop: tile.visibleCrop || tile.crop,
        cover: tile.maskedBy?.[0] || tile.coveredBy?.[0] || null,
      }];
    for (const visibleVariant of variants) {
      tileInputs.push({
        tile,
        visibleVariantKey: visibleVariant.key,
        selectedCover: visibleVariant.cover || null,
        filePath: path.join(packetDir, visibleVariant.crop),
      });
    }
  }
  const tileEmbeddingStartedAt = performance.now();
  const tileEmbeddings = new Array(tileInputs.length);
  const uncachedTileInputs = [];
  const uncachedTileByKey = new Map();
  for (let index = 0; index < tileInputs.length; index++) {
    const input = tileInputs[index];
    const fingerprint = await fileFingerprint(input.filePath);
    // The key is content-addressed. A revealed card, a changed mask, or a
    // changed crop therefore cannot inherit an embedding from its old layer.
    const cacheKey = `${input.tile.role}|${fingerprint}`;
    const cached = cacheGet(resources.tileEmbeddings, cacheKey);
    if (cached) {
      tileEmbeddings[index] = cached;
      if (timing) timing.tileEmbeddingCacheHits = (timing.tileEmbeddingCacheHits || 0) + 1;
      continue;
    }
    let pending = uncachedTileByKey.get(cacheKey);
    if (!pending) {
      pending = { cacheKey, filePath: input.filePath, indexes: [] };
      uncachedTileByKey.set(cacheKey, pending);
      uncachedTileInputs.push(pending);
    }
    pending.indexes.push(index);
  }
  const uncachedTileEmbeddings = uncachedTileInputs.length
    ? await embedPaths(extractor, uncachedTileInputs.map(input => input.filePath))
    : [];
  for (let index = 0; index < uncachedTileInputs.length; index++) {
    const input = uncachedTileInputs[index];
    const embedding = uncachedTileEmbeddings[index];
    cacheSet(resources.tileEmbeddings, input.cacheKey, embedding, TILE_EMBEDDING_CACHE_LIMIT);
    for (const tileIndex of input.indexes) tileEmbeddings[tileIndex] = embedding;
  }
  if (timing) timing.tileEmbeddingCacheMisses = uncachedTileInputs.length;
  recordTiming(timing, 'tileEmbeddingMs', tileEmbeddingStartedAt);

  // Use the full, immutable reference prototypes to select a bounded set of
  // likely labels before creating masked references. Every hidden tile still
  // gets a full-reference decision; masking is only narrowed to the candidates
  // that could change that decision, which removes the large redundant batch
  // without caching any board state or label.
  const allowedPartialReferences = new Map();
  for (let index = 0; index < tileInputs.length; index++) {
    const input = tileInputs[index];
    if (input.tile.role !== 'hidden' || !input.visibleVariantKey || !input.selectedCover) continue;
    const rankedReferences = referencePrototypes
      .map(reference => ({ reference, confidence: cosine(tileEmbeddings[index], reference.prototype) }))
      .sort((a, b) => b.confidence - a.confidence);
    // Keep one masked prototype for every library label so narrowing never
    // removes a class. Add the strongest extra variants for visual robustness.
    const selectedReferences = new Map();
    for (const item of rankedReferences) {
      if (!selectedReferences.has(item.reference.label)) {
        selectedReferences.set(referenceKey(item.reference), item.reference);
      }
    }
    for (const item of rankedReferences.slice(0, PARTIAL_REFERENCE_CANDIDATE_LIMIT)) {
      selectedReferences.set(referenceKey(item.reference), item.reference);
    }
    allowedPartialReferences.set(
      `${input.tile.id}::${input.visibleVariantKey}`,
      new Set(selectedReferences.keys()),
    );
  }

  const hiddenTiles = tiles.filter(tile => tile.role === 'hidden');
  const partialReferences = await buildPartialReferencePaths(
    packetDir,
    hiddenTiles,
    references.entries,
    timing,
    resources.partialReferenceFiles,
    allowedPartialReferences,
  );
  const partialReferenceEntries = partialReferences.entries;
  const referenceEmbeddingStartedAt = performance.now();
  const partialReferenceEmbeddings = new Array(partialReferenceEntries.length);
  const uncachedEntries = [];
  const uncachedIndexes = [];
  for (let index = 0; index < partialReferenceEntries.length; index++) {
    const entry = partialReferenceEntries[index];
    const cached = entry.cacheKey && cacheGet(resources.partialReferenceEmbeddings, entry.cacheKey);
    if (cached) {
      partialReferenceEmbeddings[index] = cached;
      if (timing) timing.partialEmbeddingCacheHits = (timing.partialEmbeddingCacheHits || 0) + 1;
    } else {
      uncachedEntries.push(entry);
      uncachedIndexes.push(index);
    }
  }
  const uncachedReferenceEmbeddings = uncachedEntries.length
    ? await embedPaths(extractor, uncachedEntries.map(entry => entry.filePath))
    : [];
  for (let index = 0; index < uncachedEntries.length; index++) {
    const entry = uncachedEntries[index];
    const embedding = uncachedReferenceEmbeddings[index];
    partialReferenceEmbeddings[uncachedIndexes[index]] = embedding;
    if (entry.cacheKey) cacheSet(
      resources.partialReferenceEmbeddings,
      entry.cacheKey,
      embedding,
      PARTIAL_EMBEDDING_CACHE_LIMIT,
    );
  }
  recordTiming(timing, 'referenceEmbeddingMs', referenceEmbeddingStartedAt);
  const partialReferenceByVariant = new Map();
  for (let index = 0; index < partialReferenceEntries.length; index++) {
    const entry = partialReferenceEntries[index];
    const key = `${entry.tileId}::${entry.visibleVariantKey}`;
    if (!partialReferenceByVariant.has(key)) partialReferenceByVariant.set(key, []);
    partialReferenceByVariant.get(key).push({ ...entry, prototype: partialReferenceEmbeddings[index] });
  }

  const inputsByTile = new Map();
  for (let index = 0; index < tileInputs.length; index++) {
    const input = { ...tileInputs[index], embedding: tileEmbeddings[index] };
    if (!inputsByTile.has(input.tile.id)) inputsByTile.set(input.tile.id, []);
    inputsByTile.get(input.tile.id).push(input);
  }

  const preliminary = tiles.map(tile => {
    const options = inputsByTile.get(tile.id) || [];
    const optionResults = options.map(option => {
      const matchesByLabel = new Map();
      const partialEntriesForVariant = tile.role === 'hidden'
        ? partialReferenceByVariant.get(`${tile.id}::${option.visibleVariantKey}`) || []
        : [];
      // Masked references add evidence for the visible fragment; they must
      // never remove the complete-reference fallback. Keeping both sets
      // preserves labels that were not among the bounded masked candidates.
      const candidateReferences = partialEntriesForVariant.length
        ? partialEntriesForVariant.concat(referencePrototypes)
        : referencePrototypes;
      for (const reference of candidateReferences) {
        const confidence = cosine(option.embedding, reference.prototype);
        const previous = matchesByLabel.get(reference.label);
        if (!previous || confidence > previous.confidence) {
          matchesByLabel.set(reference.label, {
            label: reference.label,
            variant: reference.variant,
            file: reference.file,
            confidence,
            view: reference.view || 'full',
            selectedCover: option.selectedCover,
            visibleVariantKey: option.visibleVariantKey,
          });
        }
      }
      const matches = [...matchesByLabel.values()].sort((a, b) => b.confidence - a.confidence);
      return { option, best: matches[0] || null, matches };
    }).filter(result => result.best);
    const marginOf = result => result.best && result.matches[1]
      ? result.best.confidence - result.matches[1].confidence
      : 0;
    optionResults.sort((a, b) => {
      const sameLabel = a.best?.label && a.best.label === b.best?.label;
      const marginDifference = marginOf(b) - marginOf(a);
      const confidenceDifference = a.best.confidence - b.best.confidence;
      // When both masks produce the same icon, a larger separation from the
      // next class is stronger evidence that this cover isolates the target
      // instead of merely leaving a visually similar fragment. Do not use
      // this tie-break when the masks disagree on the icon.
      if (sameLabel && Math.abs(marginDifference) >= 0.015 && Math.abs(confidenceDifference) <= 0.04) {
        return marginDifference;
      }
      return b.best.confidence - a.best.confidence;
    });
    const selected = optionResults[0] || { option: options[0], best: null, matches: [] };
    return {
      tile,
      embedding: selected.option?.embedding,
      selectedCover: selected.best?.selectedCover || selected.option?.selectedCover || null,
      visibleVariantKey: selected.best?.visibleVariantKey || selected.option?.visibleVariantKey || null,
      best: selected.best,
      matches: selected.matches,
      alternatives: selected.matches.slice(1, 3),
      coverCandidates: optionResults.map(result => ({
        visibleVariantKey: result.option.visibleVariantKey,
        selectedCover: result.option.selectedCover,
        bestLabel: result.best?.label || null,
        bestConfidence: result.best ? Number(result.best.confidence.toFixed(4)) : null,
        margin: result.best && result.matches[1]
          ? Number((result.best.confidence - result.matches[1].confidence).toFixed(4))
          : null,
      })),
    };
  });
  const postprocessStartedAt = performance.now();
  const unknownItems = preliminary.filter(item => !item.best || item.best.confidence < threshold);
  const unknownTiles = unknownItems.map(item => item.tile);
  const unknownEmbeddings = unknownItems.map(item => item.embedding);
  const unknownGroups = groupEmbeddings(unknownTiles, unknownEmbeddings, threshold);
  const unknownById = new Map(unknownGroups.predictions.map(prediction => [prediction.id, prediction]));
  const confirmedLabelCounts = new Map();
  for (const item of preliminary) {
    if (item.tile.role === 'hidden' || !item.best || item.best.confidence < threshold) continue;
    confirmedLabelCounts.set(item.best.label, (confirmedLabelCounts.get(item.best.label) || 0) + 1);
  }

  const predictions = preliminary.map(item => {
    const visibleFraction = item.tile.role === 'hidden'
      ? Number((item.tile.visibility || 0).toFixed(3))
      : 1;
    const secondBest = item.matches[1] || null;
    const partialMargin = item.best && secondBest
      ? item.best.confidence - secondBest.confidence
      : item.best?.confidence || 0;
    const partialMarginThreshold = item.selectedCover &&
      Number(item.selectedCover.confidence) >= 0.90
      ? PARTIAL_STRONG_COVER_MARGIN
      : PARTIAL_MIN_MARGIN;
    const partialNamed = Boolean(
      item.tile.role === 'hidden' &&
      item.best?.view === 'masked-visible' &&
      item.selectedCover &&
      item.best.confidence >= PARTIAL_REFERENCE_THRESHOLD &&
      visibleFraction >= PARTIAL_MIN_VISIBLE_FRACTION &&
      partialMargin >= partialMarginThreshold &&
      (confirmedLabelCounts.get(item.best.label) || 0) >= PARTIAL_CONFIRMED_PEERS,
    );
    if (item.best && (item.best.confidence >= threshold || partialNamed)) {
      return {
        id: item.tile.id,
        label: item.best.label,
        groupId: item.best.label,
        referenceLabel: item.best.label,
        referenceVariant: item.best.variant,
        referenceFile: item.best.file,
        referenceView: item.best.view || 'full',
        visibleVariant: item.visibleVariantKey,
        selectedCover: item.selectedCover,
        coverCandidates: item.coverCandidates,
        partialEvidence: partialNamed ? {
          threshold: PARTIAL_REFERENCE_THRESHOLD,
          marginThreshold: partialMarginThreshold,
          margin: Number(partialMargin.toFixed(4)),
          visibleFraction,
          confirmedPeers: confirmedLabelCounts.get(item.best.label) || 0,
        } : null,
        confidence: Number(item.best.confidence.toFixed(4)),
        visibleFraction,
        alternatives: item.alternatives.map(alternative => ({
          label: alternative.label,
          confidence: Number(alternative.confidence.toFixed(4)),
        })),
      };
    }
    const unknown = unknownById.get(item.tile.id);
    return {
      id: item.tile.id,
      label: 'unknown',
      groupId: unknown.groupId,
      confidence: Number(Math.max(0, item.best?.confidence || unknown.confidence || 0).toFixed(4)),
      visibleFraction,
      visibleVariant: item.visibleVariantKey,
      selectedCover: item.selectedCover,
      coverCandidates: item.coverCandidates,
      alternatives: item.matches.slice(0, 3).map(match => ({
        label: match.label,
        confidence: Number(match.confidence.toFixed(4)),
        view: match.view || 'full',
      })),
      partialMargin: Number(partialMargin.toFixed(4)),
    };
  });

  const namedGroups = [...new Set(predictions.filter(prediction => prediction.referenceLabel)
    .map(prediction => prediction.groupId))]
    .map(groupId => ({ groupId, label: groupId, members: predictions.filter(p => p.groupId === groupId).map(p => p.id) }));
  return {
    model,
    threshold,
    libraryDir,
    referenceCount: references.entries.length,
    missingReferences: references.missing,
    referenceVariants: partialReferences.variantDir,
    tileCount: tiles.length,
    inferenceMs: Math.round(performance.now() - classifyStartedAt),
    predictions,
    groups: namedGroups.concat(unknownGroups.groups),
    timing: {
      ...(timing || {}),
      postprocessMs: Number((performance.now() - postprocessStartedAt).toFixed(3)),
      totalMs: Number((performance.now() - classifyStartedAt).toFixed(3)),
    },
  };
}

async function classifyPacket(packetDir, options = {}) {
  const resources = await prepareClassifier(options);
  return classifyPacketWithResources(packetDir, resources);
}

async function createClassifier(options = {}) {
  const resources = await prepareClassifier(options);
  return {
    model: resources.model,
    threshold: resources.threshold,
    libraryDir: resources.libraryDir,
    referenceCount: resources.references.entries.length,
    missingReferences: resources.references.missing,
    classifyPacket: (packetDir, timing, options) => classifyPacketWithResources(packetDir, resources, timing, options),
  };
}

function safeLabel(value) {
  if (!/^[a-z][a-z0-9_-]*$/.test(value)) {
    throw new Error(`invalid icon label: ${value}; use lowercase English names such as blueberry`);
  }
  return value;
}

async function addImageReference(source, label, variant = null, libraryDir = DEFAULT_LIBRARY_DIR) {
  label = safeLabel(label);
  const sourcePath = path.resolve(source);
  const baseName = path.basename(sourcePath, path.extname(sourcePath));
  const relativeFile = path.join(label, `${baseName}.png`);
  const destination = path.resolve(libraryDir, relativeFile);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(sourcePath, destination);

  const catalog = await loadCatalog(libraryDir);
  if (!Array.isArray(catalog.icons[label])) catalog.icons[label] = [];
  const existing = catalog.icons[label].find(entry => entry.file === relativeFile);
  if (existing) {
    existing.variant = variant || existing.variant || null;
    existing.sourceImage = sourcePath;
  } else {
    catalog.icons[label].push({
      file: relativeFile,
      sourceImage: sourcePath,
      variant: variant || null,
      addedAt: new Date().toISOString(),
    });
  }
  await fs.mkdir(libraryDir, { recursive: true });
  await fs.writeFile(path.join(libraryDir, CATALOG_FILE), `${JSON.stringify(catalog, null, 2)}\n`);
  return { libraryDir, label, file: relativeFile, catalog: path.join(libraryDir, CATALOG_FILE) };
}

async function addReference(packetDir, tileId, label, variant = null, libraryDir = DEFAULT_LIBRARY_DIR) {
  const manifest = JSON.parse(await fs.readFile(path.join(packetDir, 'manifest.json'), 'utf8'));
  const tile = (manifest.tiles || []).find(item => item.id === tileId);
  if (!tile) throw new Error(`tile not found in manifest: ${tileId}`);
  const source = path.resolve(packetDir, tile.crop);
  return addImageReference(source, label, variant || tile.variant || null, libraryDir);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--add-reference') {
    if (args.length < 4) {
      console.error('usage: node local_ml.js --add-reference /path/to/packet tile-id english-label [variant]');
      process.exit(2);
    }
    const result = await addReference(args[1], args[2], args[3], args[4] || null);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args[0] === '--add-image') {
    if (args.length < 3) {
      console.error('usage: node local_ml.js --add-image /path/to/image.png english-label [variant]');
      process.exit(2);
    }
    const result = await addImageReference(args[1], args[2], args[3] || null);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const packetDir = args[0];
  if (!packetDir) {
    console.error('usage: node local_ml.js /path/to/vision-packet');
    console.error('   or: node local_ml.js --add-reference /path/to/packet tile-id english-label [variant]');
    console.error('   or: node local_ml.js --add-image /path/to/image.png english-label [variant]');
    process.exit(2);
  }
  const result = await classifyPacket(packetDir);
  const outputPath = path.join(packetDir, 'local-predictions.json');
  await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({
    outputPath,
    model: result.model,
    tileCount: result.tileCount,
    referenceCount: result.referenceCount,
    groups: result.groups.length,
    inferenceMs: result.inferenceMs,
  }, null, 2));
}

if (require.main === module) {
  main().catch(error => { console.error(error.stack || error); process.exit(1); });
}

module.exports = {
  cosine,
  groupEmbeddings,
  classifyPacket,
  createClassifier,
  loadCatalog,
  addReference,
  addImageReference,
};
