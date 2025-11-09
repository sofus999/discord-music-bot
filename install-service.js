const Service = require('node-windows').Service;
const path = require('path');

// Create a new service object
const svc = new Service({
    name: 'Discord Music Bot',
    description: 'Discord music bot with DisTube integration',
    script: path.join(__dirname, 'index.js'),
    nodeOptions: [
        '--harmony',
        '--max_old_space_size=4096'
    ],
    env: [
        {
            name: "NODE_ENV",
            value: "production"
        }
    ],
    wait: 2,
    grow: 0.5,
    maxRestarts: 0 // Don't restart on crash - stops service instead
});

// Listen for the "install" event
svc.on('install', function() {
    console.log('✅ Service installed successfully!');
    console.log('   Service name: Discord Music Bot');
    console.log('   You can now start it from services.msc');
    console.log('   Or run: net start "Discord Music Bot"');
    console.log('');
    console.log('⚠️  IMPORTANT: The service will NOT auto-restart on errors.');
    console.log('   This is by design - check logs/error-*.log for issues.');
});

svc.on('alreadyinstalled', function() {
    console.log('⚠️  Service is already installed!');
    console.log('   To reinstall, first run: npm run uninstall-service');
});

svc.on('error', function(err) {
    console.error('❌ Service installation error:', err);
    console.error('   Make sure you are running as Administrator!');
});

// Install the service
console.log('📦 Installing Discord Music Bot as Windows Service...');
console.log('   This requires Administrator privileges.');
console.log('');
svc.install();


