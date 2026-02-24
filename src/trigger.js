import { runGarbageCollector } from './index.js';
// Configuration comes from src/config.js; do not load .env

console.log('🚀 Manually triggering Garbage Collector...');
runGarbageCollector()
    .then(() => {
        console.log('✅ Manual trigger completed.');
        process.exit(0);
    })
    .catch(err => {
        console.error('❌ Manual trigger failed:', err);
        process.exit(1);
    });
