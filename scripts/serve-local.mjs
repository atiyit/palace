const owner = process.argv.find(argument => /^--owner=[a-f0-9-]{36}$/.test(argument));
if (!owner) throw new Error('Start this process through the Palace launcher.');
process.env.PALACE_LAUNCH_OWNER = owner.slice('--owner='.length);
await import('../local/server.mjs');
