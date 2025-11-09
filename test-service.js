// Test script to diagnose service issues
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

console.log('═══════════════════════════════════════════════════════════════');
console.log('Discord Music Bot - Service Diagnostics');
console.log('═══════════════════════════════════════════════════════════════\n');

// Test 1: Check environment
console.log('1. Environment Check');
console.log('   Node version:', process.version);
console.log('   Platform:', process.platform);
console.log('   Architecture:', process.arch);
console.log('   Current directory:', __dirname);
console.log('   NODE_ENV:', process.env.NODE_ENV || 'development');
console.log('   User:', process.env.USERNAME || process.env.USER);
console.log('');

// Test 2: Check FFMPEG
console.log('2. FFMPEG Check');
try {
    const ffmpegStatic = require('ffmpeg-static');
    console.log('   ✅ ffmpeg-static installed');
    console.log('   Path:', ffmpegStatic);
    console.log('   Exists:', fs.existsSync(ffmpegStatic) ? 'YES' : 'NO');
    
    if (fs.existsSync(ffmpegStatic)) {
        const stats = fs.statSync(ffmpegStatic);
        console.log('   Size:', (stats.size / 1024 / 1024).toFixed(2), 'MB');
        console.log('   Executable:', (stats.mode & fs.constants.X_OK) ? 'YES' : 'NO (might need chmod +x on Unix)');
        
        // Try to run FFMPEG
        exec(`"${ffmpegStatic}" -version`, (error, stdout, stderr) => {
            if (error) {
                console.log('   ❌ FFMPEG execution failed:', error.message);
            } else {
                const firstLine = stdout.split('\n')[0];
                console.log('   ✅ FFMPEG executable:', firstLine);
            }
        });
    }
} catch (error) {
    console.log('   ❌ ffmpeg-static not found:', error.message);
}
console.log('');

// Test 3: Check Discord.js
console.log('3. Discord.js Check');
try {
    const discord = require('discord.js');
    console.log('   ✅ discord.js installed');
    console.log('   Version:', discord.version);
} catch (error) {
    console.log('   ❌ discord.js not found:', error.message);
}
console.log('');

// Test 4: Check @discordjs/voice
console.log('4. @discordjs/voice Check');
try {
    const voice = require('@discordjs/voice');
    console.log('   ✅ @discordjs/voice installed');
    console.log('   Version:', voice.version);
    
    // Check encryption libraries
    try {
        require('tweetnacl');
        console.log('   ✅ tweetnacl available');
    } catch {
        try {
            require('sodium-native');
            console.log('   ✅ sodium-native available');
        } catch {
            console.log('   ❌ No encryption library (tweetnacl or sodium-native)');
        }
    }
} catch (error) {
    console.log('   ❌ @discordjs/voice not found:', error.message);
}
console.log('');

// Test 5: Check DisTube
console.log('5. DisTube Check');
try {
    const { DisTube } = require('distube');
    console.log('   ✅ distube installed');
} catch (error) {
    console.log('   ❌ distube not found:', error.message);
}
console.log('');

// Test 6: Check yt-dlp
console.log('6. yt-dlp Check');
try {
    const ytDlpPath = path.join(__dirname, 'node_modules', '@distube', 'yt-dlp', 'bin', 'yt-dlp.exe');
    console.log('   Path:', ytDlpPath);
    console.log('   Exists:', fs.existsSync(ytDlpPath) ? 'YES' : 'NO');
    
    if (fs.existsSync(ytDlpPath)) {
        const stats = fs.statSync(ytDlpPath);
        console.log('   Size:', (stats.size / 1024 / 1024).toFixed(2), 'MB');
    }
} catch (error) {
    console.log('   ❌ Error:', error.message);
}
console.log('');

// Test 7: Check .env file
console.log('7. Configuration Check');
const envPath = path.join(__dirname, '.env');
console.log('   .env file:', fs.existsSync(envPath) ? 'EXISTS' : 'MISSING');
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const hasToken = envContent.includes('DISCORD_TOKEN=');
    console.log('   DISCORD_TOKEN:', hasToken ? 'SET' : 'MISSING');
}
console.log('');

// Test 8: Check logs directory
console.log('8. Logs Check');
const logsDir = path.join(__dirname, 'logs');
console.log('   Logs directory:', fs.existsSync(logsDir) ? 'EXISTS' : 'WILL BE CREATED');
if (fs.existsSync(logsDir)) {
    const files = fs.readdirSync(logsDir);
    console.log('   Log files:', files.length);
    if (files.length > 0) {
        console.log('   Latest logs:');
        files.slice(-3).forEach(file => {
            const filePath = path.join(logsDir, file);
            const stats = fs.statSync(filePath);
            console.log(`     - ${file} (${(stats.size / 1024).toFixed(2)} KB)`);
        });
    }
}
console.log('');

// Test 9: Check write permissions
console.log('9. Permissions Check');
try {
    const testFile = path.join(__dirname, 'test-write-permission.tmp');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    console.log('   ✅ Write permissions OK');
} catch (error) {
    console.log('   ❌ Write permissions FAILED:', error.message);
}
console.log('');

console.log('═══════════════════════════════════════════════════════════════');
console.log('Diagnostics complete!');
console.log('═══════════════════════════════════════════════════════════════');


