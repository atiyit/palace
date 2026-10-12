import { copyFile, mkdir, access, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { projectRoot, releaseFiles, inspectRelease, printFindings, assertReleaseReady, sourceDirectories } from './release-files.mjs';

try {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length && (arguments_.length !== 2 || arguments_[0] !== '--output' || !arguments_[1])) throw new Error('Usage: npm run release:export -- [--output NEW_DIRECTORY]');
  const destination = resolve(arguments_[1] || join(projectRoot, 'outputs/github/palace-source'));
  const relativeDestination = relative(projectRoot, destination);
  if (sourceDirectories.has(relativeDestination.split(sep)[0])) throw new Error('Export destination cannot be inside a source directory. Use outputs/ or a directory outside the project.');
  let exists = false;
  try { await access(destination); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (exists) throw new Error('Export directory already exists. Choose a new --output directory; existing files are never replaced.');
  const files = await releaseFiles();
  assertReleaseReady(files);
  const { findings, manifest } = await inspectRelease(projectRoot, files);
  if (findings.length) {
    printFindings(findings);
    throw new Error('Export cancelled. Resolve the release check findings before publishing.');
  }
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination);
  for (const file of files) {
    const target = join(destination, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(projectRoot, file), target);
  }
  const copied = await inspectRelease(destination, files);
  if (copied.findings.length || JSON.stringify(copied.manifest) !== JSON.stringify(manifest)) {
    printFindings(copied.findings);
    throw new Error('Export verification failed: source changed during the copy. Do not publish this incomplete directory; retry with a new destination.');
  }
  await writeFile(join(destination, 'SOURCE-MANIFEST.json'), `${JSON.stringify({ format: 1, files: manifest }, null, 2)}\n`);
  console.log(`Exported ${files.length} source files to ${destination}`);
  console.log('No Git history, local data, provider keys, runtime binaries or hosting identities were copied. Initialize a new Git repository inside the export.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
