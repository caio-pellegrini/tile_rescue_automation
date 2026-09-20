const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_MODEL = process.env.LOCAL_VISION_MODEL || 'Xenova/clip-vit-base-patch32';
const DEFAULT_THRESHOLD = Number(process.env.LOCAL_VISION_THRESHOLD || 0.88);
const DEFAULT_LIBRARY_DIR = process.env.LOCAL_VISION_LIBRARY || path.resolve('icon-library');
const CATALOG_FILE = 'catalog.json';

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
    referencePrototypes: references.entries.map((entry, index) => ({
      label: entry.label,
      variant: entry.variant || null,
      file: entry.file,
      prototype: referenceEmbeddings[index],
    })),
  };
}

async function classifyPacketWithResources(packetDir, resources) {
  const manifest = JSON.parse(await fs.readFile(path.join(packetDir, 'manifest.json'), 'utf8'));
  const tiles = manifest.tiles || [];
  const {
    model,
    threshold,
    libraryDir,
    references,
    extractor,
    referencePrototypes,
  } = resources;
  if (!tiles.length) {
    return { model, threshold, libraryDir, referenceCount: references.entries.length, predictions: [], groups: [] };
  }

  if (!extractor || !referencePrototypes.length) {
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
    };
  }

  // Hidden candidates use a crop with the estimated cover card masked out.
  // The raw crop remains in the packet for human audit and fallback.
  const tilePaths = tiles.map(tile => path.join(packetDir, tile.visibleCrop || tile.crop));
  const started = Date.now();
  const tileEmbeddings = await embedPaths(extractor, tilePaths);

  const preliminary = tiles.map((tile, index) => {
    const matchesByLabel = new Map();
    for (const reference of referencePrototypes) {
      const confidence = cosine(tileEmbeddings[index], reference.prototype);
      const previous = matchesByLabel.get(reference.label);
      if (!previous || confidence > previous.confidence) {
        matchesByLabel.set(reference.label, {
          label: reference.label,
          variant: reference.variant,
          file: reference.file,
          confidence,
        });
      }
    }
    const matches = [...matchesByLabel.values()].sort((a, b) => b.confidence - a.confidence);
    const best = matches[0] || null;
    return { tile, index, best, alternatives: matches.slice(1, 3) };
  });
  const unknownItems = preliminary.filter(item => !item.best || item.best.confidence < threshold);
  const unknownTiles = unknownItems.map(item => item.tile);
  const unknownEmbeddings = unknownItems.map(item => tileEmbeddings[item.index]);
  const unknownGroups = groupEmbeddings(unknownTiles, unknownEmbeddings, threshold);
  const unknownById = new Map(unknownGroups.predictions.map(prediction => [prediction.id, prediction]));

  const predictions = preliminary.map(item => {
    const visibleFraction = item.tile.role === 'hidden'
      ? Number((item.tile.visibility || 0).toFixed(3))
      : 1;
    if (item.best && item.best.confidence >= threshold) {
      return {
        id: item.tile.id,
        label: item.best.label,
        groupId: item.best.label,
        referenceLabel: item.best.label,
        referenceVariant: item.best.variant,
        referenceFile: item.best.file,
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
      alternatives: item.best
        ? [{ label: item.best.label, confidence: Number(item.best.confidence.toFixed(4)) }]
        : [],
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
    tileCount: tiles.length,
    inferenceMs: Date.now() - started,
    predictions,
    groups: namedGroups.concat(unknownGroups.groups),
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
    classifyPacket: packetDir => classifyPacketWithResources(packetDir, resources),
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
