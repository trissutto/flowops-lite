const { run } = require('../customer-integrity/collect');
run().catch((error) => { console.error(error.message); process.exitCode = 1; });
