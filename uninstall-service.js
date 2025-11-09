const Service = require('node-windows').Service;
const path = require('path');

// Create a new service object
const svc = new Service({
    name: 'Discord Music Bot',
    script: path.join(__dirname, 'index.js')
});

// Listen for the "uninstall" event
svc.on('uninstall', function() {
    console.log('✅ Service uninstalled successfully!');
    console.log('   The Discord Music Bot service has been removed.');
    console.log('   You can reinstall it anytime with: npm run install-service');
});

svc.on('error', function(err) {
    console.error('❌ Uninstall error:', err);
    console.error('   Make sure you are running as Administrator!');
});

svc.on('alreadyuninstalled', function() {
    console.log('ℹ️  Service is not installed.');
});

// Uninstall the service
console.log('🗑️  Uninstalling Discord Music Bot service...');
console.log('   This requires Administrator privileges.');
console.log('');
svc.uninstall();


