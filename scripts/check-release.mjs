import { projectRoot, releaseFiles, inspectRelease, printFindings, assertReleaseReady } from './release-files.mjs';

try {
  const files = await releaseFiles();
  assertReleaseReady(files);
  const { findings } = await inspectRelease(projectRoot, files);
  if (findings.length) {
    printFindings(findings);
    process.exitCode = 1;
  } else {
    console.log(`PASS ${files.length} public source files checked. Local data, hosting identities and Git history are excluded.`);
    console.log('This checks the clean export file set; it does not certify your existing Git history. Publish the export in a new repository.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
