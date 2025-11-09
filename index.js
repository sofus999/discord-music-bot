const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { DisTube } = require('distube');
const { YtDlpPlugin } = require('@distube/yt-dlp');
const { joinVoiceChannel, entersState, VoiceConnectionStatus } = require('@discordjs/voice');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Configure Winston logging for service mode
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
}

// Configure logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.printf(({ timestamp, level, message, stack }) => {
            return `[${timestamp}] ${level.toUpperCase()}: ${stack || message}`;
        })
    ),
    transports: [
        // Console output
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        }),
        // Daily rotating file for all logs
        new DailyRotateFile({
            filename: path.join(logsDir, 'bot-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '14d',
            level: 'info'
        }),
        // Daily rotating file for errors only
        new DailyRotateFile({
            filename: path.join(logsDir, 'error-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '30d',
            level: 'error'
        })
    ]
});

// Override console methods to use logger (for service mode)
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => {
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
    originalLog(...args);
    logger.info(message);
};

console.error = (...args) => {
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
    originalError(...args);
    logger.error(message);
};

console.warn = (...args) => {
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
    originalWarn(...args);
    logger.warn(message);
};

// Log startup
logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
logger.info('Discord Music Bot starting...');
logger.info(`Node version: ${process.version}`);
logger.info(`Platform: ${process.platform}`);
logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// Configure FFMPEG - @discordjs/voice checks process.env.FFMPEG_PATH
const ffmpegPath = require('ffmpeg-static');
process.env.FFMPEG_PATH = ffmpegPath;

// Force load encryption library before voice connection
try {
    require('tweetnacl');
    console.log('✅ Loaded tweetnacl for encryption');
} catch {
    console.log('⚠️ tweetnacl not available, trying sodium...');
    try {
        require('sodium-native');
        console.log('✅ Loaded sodium-native for encryption');
    } catch {
        console.log('⚠️ No encryption library found!');
    }
}

// Create Discord client with all necessary intents
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent
    ]
});

// Configure DisTube 5.0 with valid options only  
const distube = new DisTube(client, {
    emitNewSongOnly: false,
    emitAddSongWhenCreatingQueue: true,
    emitAddListWhenCreatingQueue: true,
    nsfw: true,
    ffmpeg: {
        path: ffmpegPath
    },
    plugins: [
        new YtDlpPlugin({
            update: false
        })
    ]
});

// Add debug logging for DisTube
logger.info('DisTube initialized with FFMPEG path: ' + ffmpegPath);

// Fix MaxListeners warning
distube.setMaxListeners(20);

// Global song history tracker - prevents repeating songs across sessions
// Stores video IDs of recently played songs (max 100)
const globalSongHistory = new Set();
const MAX_HISTORY_SIZE = 100;

// Track when we're bulk-loading playlists/radio to suppress "Added to Queue" messages
const bulkLoadingGuilds = new Set();

function addToHistory(videoId) {
    if (!videoId) return;
    globalSongHistory.add(videoId);
    
    // Keep history size manageable
    if (globalSongHistory.size > MAX_HISTORY_SIZE) {
        // Remove oldest entries (convert to array, remove first items, recreate Set)
        const historyArray = Array.from(globalSongHistory);
        const toKeep = historyArray.slice(historyArray.length - MAX_HISTORY_SIZE);
        globalSongHistory.clear();
        toKeep.forEach(id => globalSongHistory.add(id));
    }
    
    console.log(`   📚 History size: ${globalSongHistory.size} songs`);
}

function getRecentHistoryIds(queue) {
    const recentIds = new Set(globalSongHistory);
    
    // Also add current queue songs
    if (queue) {
        if (queue.songs) {
            queue.songs.forEach(s => s.id && recentIds.add(s.id));
        }
        if (queue.previousSongs) {
            queue.previousSongs.slice(-10).forEach(s => s.id && recentIds.add(s.id));
        }
    }
    
    return recentIds;
}

process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error);
});

// Function to load YouTube cookies
function getYouTubeCookies() {
    const cookiesFile = process.env.YOUTUBE_COOKIES_FILE || 'youtube-cookies.txt';
    try {
        if (fs.existsSync(cookiesFile)) {
            const cookies = fs.readFileSync(cookiesFile, 'utf8');
            // Filter out comments and empty lines
            const validCookies = cookies
                .split('\n')
                .filter(line => line.trim() && !line.startsWith('#'))
                .join('; ');
            return validCookies;
        }
    } catch (error) {
        console.warn('Warning: Could not load YouTube cookies:', error.message);
    }
    return '';
}

// Bot ready event (using clientReady to avoid deprecation warning)
client.once('clientReady', async () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🎵 Music Bot is ready!');
    console.log(`   Logged in as: ${client.user.tag}`);
    console.log(`   Bot ID: ${client.user.id}`);
    console.log(`   Servers: ${client.guilds.cache.size}`);
    console.log(`   yt-dlp: Installed at node_modules/@distube/yt-dlp/bin/yt-dlp.exe`);
    console.log(`   FFmpeg: ${process.env.FFMPEG_PATH || 'Not configured'}`);
    console.log(`   Running as service: ${process.env.NODE_ENV === 'production' ? 'YES' : 'NO'}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    // Register slash commands
    await registerSlashCommands();
    
    // Log voice state updates for debugging
    client.on('voiceStateUpdate', (oldState, newState) => {
        if (newState.member?.user?.id === client.user.id) {
            logger.info(`Voice state update: ${oldState.channel?.name || 'None'} -> ${newState.channel?.name || 'None'}`);
        }
    });
});

// Register slash commands
async function registerSlashCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName('play')
            .setDescription('Play a song or add to queue')
            .addStringOption(option =>
                option.setName('query')
                    .setDescription('Song name, artist, or URL (YouTube, SoundCloud, Spotify)')
                    .setRequired(true)
            ),
        
        new SlashCommandBuilder()
            .setName('skip')
            .setDescription('Skip songs in the queue')
            .addIntegerOption(option =>
                option.setName('amount')
                    .setDescription('Number of songs to skip (default: 1)')
                    .setMinValue(1)
                    .setMaxValue(10)
            ),
        
        new SlashCommandBuilder()
            .setName('stop')
            .setDescription('Stop the music and clear the queue'),
        
        new SlashCommandBuilder()
            .setName('queue')
            .setDescription('Show the current queue')
            .addIntegerOption(option =>
                option.setName('page')
                    .setDescription('Page number to display')
                    .setMinValue(1)
            ),
        
        new SlashCommandBuilder()
            .setName('np')
            .setDescription('Show the currently playing song'),
        
        new SlashCommandBuilder()
            .setName('pause')
            .setDescription('Pause the current song'),
        
        new SlashCommandBuilder()
            .setName('resume')
            .setDescription('Resume the paused song'),
        
        new SlashCommandBuilder()
            .setName('volume')
            .setDescription('Set the volume (0-100)')
            .addIntegerOption(option =>
                option.setName('amount')
                    .setDescription('Volume level (0-100)')
                    .setMinValue(0)
                    .setMaxValue(100)
                    .setRequired(true)
            ),
        
        new SlashCommandBuilder()
            .setName('shuffle')
            .setDescription('Shuffle the queue'),
        
        new SlashCommandBuilder()
            .setName('repeat')
            .setDescription('Set repeat mode')
            .addStringOption(option =>
                option.setName('mode')
                    .setDescription('Repeat mode')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Off', value: '0' },
                        { name: 'Repeat Song', value: '1' },
                        { name: 'Repeat Queue', value: '2' }
                    )
            ),
        
        new SlashCommandBuilder()
            .setName('autoplay')
            .setDescription('Toggle auto-play mode (like Rythm)'),
        
        new SlashCommandBuilder()
            .setName('jump')
            .setDescription('Jump to a specific song in the queue')
            .addIntegerOption(option =>
                option.setName('position')
                    .setDescription('Position in queue to jump to')
                    .setMinValue(1)
                    .setRequired(true)
            ),
        
        new SlashCommandBuilder()
            .setName('remove')
            .setDescription('Remove a song from the queue')
            .addIntegerOption(option =>
                option.setName('position')
                    .setDescription('Position in queue to remove')
                    .setMinValue(1)
                    .setRequired(true)
            ),
        
        new SlashCommandBuilder()
            .setName('clear')
            .setDescription('Clear the entire queue'),
        
        new SlashCommandBuilder()
            .setName('search')
            .setDescription('Search for songs and add to queue')
            .addStringOption(option =>
                option.setName('query')
                    .setDescription('Search query')
                    .setRequired(true)
            ),
        
        new SlashCommandBuilder()
            .setName('playnow')
            .setDescription('Play a song immediately (clears current queue and starts fresh)')
            .addStringOption(option =>
                option.setName('query')
                    .setDescription('Song name, artist, or URL')
                    .setRequired(true)
            ),
        
        new SlashCommandBuilder()
            .setName('seek')
            .setDescription('Seek to a specific time in the current song')
            .addStringOption(option =>
                option.setName('time')
                    .setDescription('Time to seek to (e.g., 1:30, 90, 0:45)')
                    .setRequired(true)
            ),
        
        new SlashCommandBuilder()
            .setName('playradio')
            .setDescription('Play a YouTube radio/mix (auto-generated playlist)')
            .addStringOption(option =>
                option.setName('url')
                    .setDescription('YouTube radio/mix URL')
                    .setRequired(true)
            ),
        
        new SlashCommandBuilder()
            .setName('playlist')
            .setDescription('Play a YouTube playlist')
            .addStringOption(option =>
                option.setName('url')
                    .setDescription('YouTube playlist URL')
                    .setRequired(true)
            )
    ];

    try {
        console.log('🔄 Registering slash commands...');
        await client.application.commands.set(commands);
        console.log('✅ Slash commands registered successfully!');
    } catch (error) {
        console.error('❌ Error registering slash commands:', error);
    }
}

// Handle slash command and button interactions
client.on('interactionCreate', async (interaction) => {
    // Handle button interactions (seek buttons)
    if (interaction.isButton()) {
        if (interaction.customId.startsWith('seek_')) {
            await handleSeekButton(interaction);
        }
        return;
    }
    
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    const member = interaction.member;
    const voiceChannel = member?.voice?.channel;

    // Debug logging
    console.log(`Command: ${commandName}, Member: ${member?.user?.username}, Voice Channel: ${voiceChannel?.name || 'None'}`);

    // Check if user is in a voice channel (for music commands)
    if (['play', 'skip', 'stop', 'pause', 'resume', 'volume', 'shuffle', 'repeat', 'autoplay', 'search', 'playnow', 'seek', 'playradio', 'playlist'].includes(commandName)) {
        if (!voiceChannel) {
            console.log('User not in voice channel');
            return interaction.reply({
                content: '❌ You need to be in a voice channel to use music commands!',
                ephemeral: true
            });
        }

        const permissions = voiceChannel.permissionsFor(interaction.guild.members.me);
        if (!permissions.has('Connect') || !permissions.has('Speak')) {
            return interaction.reply({
                content: '❌ I don\'t have permission to join or speak in that voice channel!',
                ephemeral: true
            });
        }
    }

    try {
        switch (commandName) {
            case 'play':
                await handlePlay(interaction);
                break;
            case 'skip':
                await handleSkip(interaction);
                break;
            case 'stop':
                await handleStop(interaction);
                break;
            case 'queue':
                await handleQueue(interaction);
                break;
            case 'np':
                await handleNowPlaying(interaction);
                break;
            case 'pause':
                await handlePause(interaction);
                break;
            case 'resume':
                await handleResume(interaction);
                break;
            case 'volume':
                await handleVolume(interaction);
                break;
            case 'shuffle':
                await handleShuffle(interaction);
                break;
            case 'repeat':
                await handleRepeat(interaction);
                break;
            case 'autoplay':
                await handleAutoplay(interaction);
                break;
            case 'jump':
                await handleJump(interaction);
                break;
            case 'remove':
                await handleRemove(interaction);
                break;
            case 'clear':
                await handleClear(interaction);
                break;
            case 'search':
                await handleSearch(interaction);
                break;
            case 'playnow':
                await handlePlayNow(interaction);
                break;
            case 'seek':
                await handleSeek(interaction);
                break;
            case 'playradio':
                await handlePlayRadio(interaction);
                break;
            case 'playlist':
                await handlePlaylist(interaction);
                break;
        }
    } catch (error) {
        console.error(`Error handling ${commandName} command:`, error);
        const errorMessage = error.message || 'An unknown error occurred';
        await interaction.reply({
            content: `❌ Error: ${errorMessage}`,
            ephemeral: true
        });
    }
});

// Helper function to search YouTube using yt-dlp and get the video URL
// resultNumber: which result to return (1 = first, 2 = second, etc.) - useful for autoplay variety
async function searchYouTube(query, resultNumber = 1) {
    return new Promise((resolve, reject) => {
        const ytDlpPath = path.join(__dirname, 'node_modules', '@distube', 'yt-dlp', 'bin', 'yt-dlp.exe');
        
        // Search for more results to filter properly
        const searchCount = 15;
        const args = [
            '--dump-json',
            '--no-warnings',
            '--no-playlist',
            '--flat-playlist',
            `ytsearch${searchCount}:${query}`
        ];
        
        const ytdlp = spawn(ytDlpPath, args);
        let output = '';
        let errorOutput = '';
        
        ytdlp.stdout.on('data', (data) => {
            output += data.toString();
        });
        
        ytdlp.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });
        
        ytdlp.on('close', (code) => {
            if (code === 0 && output.trim()) {
                const lines = output.trim().split('\n').filter(line => line.trim());
                
                if (lines.length === 0) {
                    reject(new Error(`Could not find any results for: ${query}`));
                    return;
                }
                
                // Parse JSON results and filter for actual music
                const videos = [];
                for (const line of lines) {
                    try {
                        const video = JSON.parse(line);
                        videos.push({
                            id: video.id,
                            title: video.title || '',
                            duration: video.duration || 0
                        });
                    } catch (e) {
                        // Skip malformed JSON
                    }
                }
                
                if (videos.length === 0) {
                    reject(new Error(`No valid results for: ${query}`));
                    return;
                }
                
                // Filter out bad content (compilations, reactions, etc.)
                const badKeywords = ['compilation', 'reaction', 'until', 'mashup', 'hour', 'hours', 'mix', 'playlist', 'rapping', 'talking', 'commentary', 'challenge'];
                const goodVideos = videos.filter(video => {
                    const lowerTitle = video.title.toLowerCase();
                    
                    // Filter out videos with bad keywords
                    if (badKeywords.some(keyword => lowerTitle.includes(keyword))) {
                        return false;
                    }
                    
                    // Filter out very long videos (likely compilations)
                    if (video.duration > 600) { // > 10 minutes
                        return false;
                    }
                    
                    // Filter out very short videos (likely clips)
                    if (video.duration < 60) { // < 1 minute
                        return false;
                    }
                    
                    return true;
                });
                
                // Use filtered results or fall back to all results if none pass the filter
                const resultsToUse = goodVideos.length > 0 ? goodVideos : videos;
                
                // Pick the requested result
                const index = Math.min(resultNumber - 1, resultsToUse.length - 1);
                const video = resultsToUse[index];
                const videoUrl = `https://www.youtube.com/watch?v=${video.id}`;
                console.log(`   ✅ Found: ${video.title} (${Math.floor(video.duration / 60)}:${(video.duration % 60).toString().padStart(2, '0')})`);
                resolve(videoUrl);
            } else {
                reject(new Error(`Could not find any results for: ${query}. Error: ${errorOutput}`));
            }
        });
        
        ytdlp.on('error', (error) => {
            reject(error);
        });
    });
}

// Helper function to generate smart search queries with variety and duplicate prevention
function getSmartSearchQuery(currentSong, queue) {
    // Extract artist and song name
    const songName = currentSong.name;
    const uploader = currentSong.uploader?.name || '';
    
    // Get recently played video IDs to avoid duplicates
    const recentIds = new Set();
    
    // Add current song
    if (currentSong.id) recentIds.add(currentSong.id);
    
    // Add songs from queue
    if (queue.songs) {
        queue.songs.forEach(song => {
            if (song.id) recentIds.add(song.id);
        });
    }
    
    // Add recently played songs
    if (queue.previousSongs) {
        queue.previousSongs.slice(-10).forEach(song => {
            if (song.id) recentIds.add(song.id);
        });
    }
    
    console.log('   📝 Recently played IDs to avoid:', Array.from(recentIds).slice(0, 5));
    
    // Build varied search queries based on song information
    const searchStrategies = [];
    
    // Strategy 1: Artist name (if available)
    if (uploader && uploader.length > 2) {
        searchStrategies.push(uploader);
    }
    
    // Strategy 2: Extract artist from "Artist - Song" format
    if (songName.includes('-')) {
        const artist = songName.split('-')[0].trim();
        if (artist.length > 2) {
            searchStrategies.push(artist);
        }
    }
    
    // Strategy 3: Genre-based searches (detect common genres from keywords)
    const lowerName = songName.toLowerCase();
    if (lowerName.includes('rock') || uploader.toLowerCase().includes('rock')) {
        searchStrategies.push('alternative rock', 'rock music');
    }
    if (lowerName.includes('pop') || lowerName.includes('hits')) {
        searchStrategies.push('pop hits', 'popular music');
    }
    if (lowerName.includes('electronic') || lowerName.includes('edm') || uploader.toLowerCase().includes('electronic')) {
        searchStrategies.push('electronic music', 'EDM');
    }
    if (lowerName.includes('metal')) {
        searchStrategies.push('metal music', 'heavy metal');
    }
    
    // Strategy 4: If we have artist, add "similar to [artist]"
    if (uploader && uploader.length > 2) {
        searchStrategies.push(`similar to ${uploader}`);
        searchStrategies.push(`artists like ${uploader}`);
    }
    
    // Pick a random strategy
    if (searchStrategies.length > 0) {
        const randomStrategy = searchStrategies[Math.floor(Math.random() * searchStrategies.length)];
        return randomStrategy;
    }
    
    // Fallback: Use first part of song name or uploader
    return uploader || songName.split('-')[0].trim() || songName.split('(')[0].trim();
}

// Helper function to search and filter duplicates with music filtering
async function searchYouTubeNoDuplicates(query, recentIds, resultNumber = 1) {
    try {
        // Add music-specific keywords to search
        const musicKeywords = ['official audio', 'official music video', 'official video', 'audio', 'music video'];
        const musicQuery = `${query} ${musicKeywords[Math.floor(Math.random() * musicKeywords.length)]}`;
        
        // Search for many more results so we can filter properly
        const searchCount = 20;
        
        const ytDlpPath = path.join(__dirname, 'node_modules', '@distube', 'yt-dlp', 'bin', 'yt-dlp.exe');
        const args = [
            '--dump-json',
            '--no-warnings',
            '--no-playlist',
            '--flat-playlist',
            `ytsearch${searchCount}:${musicQuery}`
        ];
        
        return new Promise((resolve, reject) => {
            const ytdlp = spawn(ytDlpPath, args);
            let output = '';
            let errorOutput = '';
            
            ytdlp.stdout.on('data', (data) => {
                output += data.toString();
            });
            
            ytdlp.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });
            
            ytdlp.on('close', (code) => {
                if (code === 0 && output.trim()) {
                    const lines = output.trim().split('\n').filter(line => line.trim());
                    
                    if (lines.length === 0) {
                        reject(new Error(`No results for: ${query}`));
                        return;
                    }
                    
                    // Parse JSON results and filter for actual music
                    const videos = [];
                    for (const line of lines) {
                        try {
                            const video = JSON.parse(line);
                            videos.push({
                                id: video.id,
                                title: video.title || '',
                                duration: video.duration || 0
                            });
                        } catch (e) {
                            // Skip malformed JSON
                        }
                    }
                    
                    if (videos.length === 0) {
                        reject(new Error(`No valid results for: ${query}`));
                        return;
                    }
                    
                    // Filter out bad content (compilations, reactions, etc.)
                    const badKeywords = ['compilation', 'reaction', 'until', 'mashup', 'hour', 'hours', 'mix', 'playlist', 'rapping', 'talking', 'commentary', 'challenge'];
                    const goodVideos = videos.filter(video => {
                        const lowerTitle = video.title.toLowerCase();
                        
                        // Filter out videos with bad keywords
                        if (badKeywords.some(keyword => lowerTitle.includes(keyword))) {
                            return false;
                        }
                        
                        // Filter out very long videos (likely compilations)
                        // Most songs are 2-6 minutes (120-360 seconds)
                        if (video.duration > 600) { // > 10 minutes
                            return false;
                        }
                        
                        // Filter out very short videos (likely clips)
                        if (video.duration < 60) { // < 1 minute
                            return false;
                        }
                        
                        return true;
                    });
                    
                    // Use filtered results or fall back to all results
                    const resultsToUse = goodVideos.length > 0 ? goodVideos : videos;
                    
                    // Filter out duplicates
                    const uniqueVideos = resultsToUse.filter(video => !recentIds.has(video.id));
                    
                    if (uniqueVideos.length === 0) {
                        console.log('   ⚠️  All results were duplicates, using any result');
                        const video = resultsToUse[0];
                        const videoUrl = `https://www.youtube.com/watch?v=${video.id}`;
                        console.log(`   ✅ Using result (duplicate): ${video.title}`);
                        resolve(videoUrl);
                        return;
                    }
                    
                    // Use the first unique, good result
                    const video = uniqueVideos[0];
                    const videoUrl = `https://www.youtube.com/watch?v=${video.id}`;
                    console.log(`   ✅ Found music: ${video.title} (${Math.floor(video.duration / 60)}:${(video.duration % 60).toString().padStart(2, '0')})`);
                    resolve(videoUrl);
                } else {
                    reject(new Error(`Search failed for: ${query}. Error: ${errorOutput}`));
                }
            });
            
            ytdlp.on('error', (error) => {
                reject(error);
            });
        });
    } catch (error) {
        // Fallback to regular search
        return searchYouTube(query, resultNumber);
    }
}

// Helper function to extract playlist videos using yt-dlp
async function getPlaylistVideos(playlistUrl, maxVideos = 50) {
    return new Promise((resolve, reject) => {
        const ytDlpPath = path.join(__dirname, 'node_modules', '@distube', 'yt-dlp', 'bin', 'yt-dlp.exe');
        const args = [
            '--dump-json',
            '--flat-playlist',
            '--no-warnings',
            '--playlist-end', maxVideos.toString(),
            playlistUrl
        ];
        
        console.log(`   📋 Extracting playlist info...`);
        const ytdlp = spawn(ytDlpPath, args);
        let output = '';
        let errorOutput = '';
        
        ytdlp.stdout.on('data', (data) => {
            output += data.toString();
        });
        
        ytdlp.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });
        
        ytdlp.on('close', (code) => {
            if (code === 0 && output.trim()) {
                const lines = output.trim().split('\n').filter(line => line.trim());
                const videos = [];
                
                for (const line of lines) {
                    try {
                        const video = JSON.parse(line);
                        videos.push({
                            id: video.id,
                            title: video.title || 'Unknown Title',
                            url: `https://www.youtube.com/watch?v=${video.id}`,
                            duration: video.duration || 0
                        });
                    } catch (e) {
                        // Skip malformed JSON
                    }
                }
                
                console.log(`   ✅ Found ${videos.length} videos in playlist`);
                resolve(videos);
            } else {
                reject(new Error(`Failed to extract playlist: ${errorOutput}`));
            }
        });
        
        ytdlp.on('error', (error) => {
            reject(error);
        });
    });
}

// Button interaction handlers
async function handleSeekButton(interaction) {
    const queue = distube.getQueue(interaction.guildId);
    
    // Check if user is in voice channel
    if (!interaction.member?.voice?.channel) {
        return interaction.reply({
            content: '❌ You need to be in a voice channel to use seek buttons!',
            ephemeral: true
        });
    }
    
    if (!queue || !queue.songs[0]) {
        return interaction.reply({
            content: '❌ There is no music playing!',
            ephemeral: true
        });
    }

    try {
        // Parse the seek amount from the button ID (e.g., "seek_-30" -> -30)
        const seekAmount = parseInt(interaction.customId.replace('seek_', ''));
        const currentSong = queue.songs[0];
        
        // Calculate new position (currentTime + seekAmount)
        // Note: DisTube doesn't provide currentTime directly in the queue, 
        // so we'll use the seek method with relative positioning
        const currentTime = queue.currentTime || 0;
        let newTime = currentTime + seekAmount;
        
        // Clamp to valid range [0, duration]
        newTime = Math.max(0, Math.min(newTime, currentSong.duration - 1));
        
        console.log(`🎯 Button seek: ${seekAmount}s (from ${formatTime(currentTime)} to ${formatTime(newTime)})`);
        
        await interaction.deferReply({ ephemeral: true });
        await distube.seek(interaction.guildId, newTime);
        
        const seekEmoji = seekAmount > 0 ? '⏩' : '⏪';
        await interaction.editReply({
            content: `${seekEmoji} Seeked ${seekAmount > 0 ? '+' : ''}${seekAmount}s to **${formatTime(newTime)}**`
        });
    } catch (error) {
        console.error('Button seek error:', error);
        await interaction.reply({
            content: `❌ Error seeking: ${error.message || 'Failed to seek'}`,
            ephemeral: true
        });
    }
}

// Command handlers
async function handlePlay(interaction) {
    let query = interaction.options.getString('query');
    const voiceChannel = interaction.member?.voice?.channel;

    await interaction.deferReply();

    try {
        // Remove surrounding quotes if present (handles both "" and '')
        query = query.trim().replace(/^["']|["']$/g, '');
        
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🎵 Play Command Initiated');
        console.log('   User:', interaction.user.tag);
        console.log('   Original Query:', interaction.options.getString('query'));
        console.log('   Cleaned Query:', query);
        console.log('   Voice Channel:', voiceChannel.name);
        console.log('   Guild:', interaction.guild.name);
        
        // Check if it's a URL
        const isUrl = query.startsWith('http://') || query.startsWith('https://') || query.startsWith('www.');
        
        let finalQuery = query;
        
        // If not a URL, use yt-dlp to search and get the video URL
        if (!isUrl) {
            console.log('   🔍 Searching YouTube for:', query);
            finalQuery = await searchYouTube(query);
        }
        
        console.log('   ▶️  Playing:', finalQuery);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        // Check if there's an existing queue before adding the song
        const queueBefore = distube.getQueue(interaction.guildId);
        const hadQueueBefore = queueBefore && queueBefore.songs.length > 0;
        
        console.log('   🔌 Attempting to join voice channel and play...');
        
        // Add timeout to prevent hanging forever
        const playPromise = distube.play(voiceChannel, finalQuery, {
            textChannel: interaction.channel,
            member: interaction.member
        });
        
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Play operation timed out after 30 seconds')), 30000);
        });
        
        const result = await Promise.race([playPromise, timeoutPromise]);
        
        console.log('✅ Play command successful:', result?.name || 'Unknown');
        
        // If there was a queue before, move the newly added song to maintain proper queue order:
        // Manual songs (FIFO) should come before all auto-added songs
        if (hadQueueBefore && !bulkLoadingGuilds.has(interaction.guildId)) {
            setTimeout(() => {
                try {
                    const queue = distube.getQueue(interaction.guildId);
                    if (queue && queue.songs.length > 1) {
                        // The newly added song is at the end
                        const newSong = queue.songs[queue.songs.length - 1];
                        
                        // Find the position of the last manually added song
                        // Songs with .user property are manually added
                        let insertPosition = 1; // Default: right after currently playing
                        
                        for (let i = queue.songs.length - 2; i >= 0; i--) { // -2 to skip the newSong we just added
                            if (queue.songs[i].user) {
                                // Found a manually added song, insert after it
                                insertPosition = i + 1;
                                break;
                            }
                        }
                        
                        // Move the new song to the correct position
                        queue.songs.splice(queue.songs.length - 1, 1); // Remove from end
                        queue.songs.splice(insertPosition, 0, newSong); // Insert at correct position
                        
                        console.log(`   🔝 Moved "${newSong.name}" to position ${insertPosition + 1} (after last manual song)`);
                    }
                } catch (error) {
                    console.error('   ❌ Error reordering queue:', error.message);
                }
            }, 100);
        }
        
        // Enable autoplay by default on new queues (with a small delay to ensure queue is ready)
        setTimeout(async () => {
            try {
                const queue = distube.getQueue(interaction.guildId);
                if (queue && !queue.autoplay) {
                    await distube.toggleAutoplay(interaction.guildId);
                    console.log('🔄 Auto-play enabled by default');
                } else if (queue) {
                    console.log('ℹ️  Auto-play already enabled:', queue.autoplay);
                } else {
                    console.log('⚠️  Queue not found after play');
                }
            } catch (error) {
                console.error('❌ Error enabling autoplay:', error.message);
            }
        }, 500);

        if (result) {
            // Wait a bit for queue reordering to complete
            await new Promise(resolve => setTimeout(resolve, 150));
            
            const queue = distube.getQueue(interaction.guildId);
            let position = '1';
            
            // Find the position of the song in the queue
            if (queue && queue.songs.length > 0) {
                const songIndex = queue.songs.findIndex(s => s.id === result.id);
                position = songIndex >= 0 ? (songIndex + 1).toString() : queue.songs.length.toString();
            }
            
            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('🎵 Added to Queue')
                .setDescription(`**${result.name}**`)
                .addFields(
                    { name: 'Duration', value: result.formattedDuration, inline: true },
                    { name: 'Requested by', value: interaction.user.toString(), inline: true },
                    { name: 'Position in queue', value: position, inline: true }
                )
                .setThumbnail(result.thumbnail)
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        }
    } catch (error) {
        console.error('❌ Play command error:', error);
        console.error('Error code:', error.errorCode);
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        
        logger.error('Play command failed:', error);
        logger.error('Error details:', {
            code: error.errorCode,
            message: error.message,
            query: query,
            isUrl: query.startsWith('http')
        });
        
        let errorMessage = 'Could not play the song. ';
        
        if (error.message && error.message.includes('timed out')) {
            errorMessage += 'Voice connection timed out. This can happen when running as a service. Try restarting the service or check logs/error-*.log for details.';
            logger.error('TIMEOUT: Voice connection or play operation timed out after 30 seconds');
        } else if (error.errorCode === 'NO_RESULT') {
            errorMessage += `No results found for "${query}". Try a different search term or provide a direct YouTube URL.`;
        } else if (error.message && error.message.includes('Sign in to confirm')) {
            errorMessage += 'YouTube is asking for age verification. Try a different video or use a YouTube URL.';
        } else if (error.message && error.message.includes('spawn') && error.message.includes('ENOENT')) {
            errorMessage += 'yt-dlp binary not found. Please run: npm rebuild @distube/yt-dlp';
        } else if (error.message && error.message.includes('ffmpeg')) {
            errorMessage += 'FFMPEG error. Check logs/error-*.log for details.';
        } else {
            errorMessage += error.message || 'Unknown error occurred';
        }
        
        try {
            await interaction.editReply({
                content: `❌ ${errorMessage}`
            });
        } catch (replyError) {
            logger.error('Failed to send error reply:', replyError);
        }
    }
}

// Radio command - starts a fresh radio station based on a song
async function handlePlayNow(interaction) {
    let query = interaction.options.getString('query');
    const voiceChannel = interaction.member?.voice?.channel;

    await interaction.deferReply();

    try {
        // Remove surrounding quotes if present
        query = query.trim().replace(/^["']|["']$/g, '');
        
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('▶️ Play Now Command Initiated');
        console.log('   User:', interaction.user.tag);
        console.log('   Query:', query);
        console.log('   Voice Channel:', voiceChannel.name);
        console.log('   Guild:', interaction.guild.name);
        
        // Stop and clear current queue if exists
        const existingQueue = distube.getQueue(interaction.guildId);
        if (existingQueue) {
            console.log('   🛑 Stopping existing queue...');
            await distube.stop(interaction.guildId);
            console.log('   ✅ Queue stopped and cleared');
        }
        
        // Clear global history for fresh start
        console.log('   🧹 Clearing song history for fresh start...');
        globalSongHistory.clear();
        console.log('   ✅ History cleared');
        
        // Check if it's a URL
        const isUrl = query.startsWith('http://') || query.startsWith('https://') || query.startsWith('www.');
        
        let finalQuery = query;
        
        // If not a URL, use yt-dlp to search and get the video URL
        if (!isUrl) {
            console.log('   🔍 Searching YouTube for:', query);
            finalQuery = await searchYouTube(query);
        }
        
        console.log('   ▶️ Playing now:', finalQuery);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const result = await distube.play(voiceChannel, finalQuery, {
            textChannel: interaction.channel,
            member: interaction.member
        });
        
        console.log('✅ PlayNow started successfully:', result?.name || 'Unknown');
        
        // Enable autoplay (with a small delay to ensure queue is ready)
        setTimeout(async () => {
            try {
                const queue = distube.getQueue(interaction.guildId);
                if (queue && !queue.autoplay) {
                    await distube.toggleAutoplay(interaction.guildId);
                    console.log('▶️ PlayNow: Auto-play enabled');
                } else if (queue) {
                    console.log('ℹ️  PlayNow: Auto-play already enabled');
                } else {
                    console.log('⚠️  Queue not found after radio start');
                }
            } catch (error) {
                console.error('❌ Error enabling autoplay for radio:', error.message);
            }
        }, 500);

        if (result) {
            const embed = new EmbedBuilder()
                .setColor('#ff00ff')
                .setTitle('▶️ Playing Now')
                .setDescription(`**${result.name}**\n\n🎶 Auto-play enabled - Similar songs will play automatically!`)
                .addFields(
                    { name: 'Duration', value: result.formattedDuration, inline: true },
                    { name: 'Requested by', value: interaction.user.toString(), inline: true }
                )
                .setThumbnail(result.thumbnail)
                .setFooter({ text: 'Clears the queue and starts fresh' })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        }
    } catch (error) {
        console.error('❌ PlayNow command error:', error);
        console.error('Error message:', error.message);
        
        let errorMessage = 'Could not play the song. ';
        
        if (error.errorCode === 'NO_RESULT') {
            errorMessage += `No results found for "${query}". Try a different search term or provide a direct YouTube URL.`;
        } else if (error.message.includes('Sign in to confirm')) {
            errorMessage += 'YouTube is asking for age verification. Try a different video.';
        } else {
            errorMessage += error.message;
        }
        
        await interaction.editReply({
            content: `❌ ${errorMessage}`
        });
    }
}

async function handleSkip(interaction) {
    const queue = distube.getQueue(interaction.guildId);
    const amount = interaction.options.getInteger('amount') || 1;
    
    if (!queue) {
        return interaction.reply({
            content: '❌ There is no music playing!',
            ephemeral: true
        });
    }

    if (amount > queue.songs.length) {
        return interaction.reply({
            content: `❌ Cannot skip ${amount} songs! Queue only has ${queue.songs.length} songs.`,
            ephemeral: true
        });
    }

    // CRITICAL: Defer reply immediately to prevent timeout (Discord requires response within 3 seconds)
    await interaction.deferReply();

    try {
        const skippedSongs = queue.songs.slice(0, amount);
        
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('⏭️ Skip command processing');
        console.log('   Songs in queue:', queue.songs.length);
        console.log('   Amount to skip:', amount);
        console.log('   Autoplay enabled:', queue.autoplay);
        console.log('   Previous songs count:', queue.previousSongs?.length || 0);
        
        // Simple skip logic
        if (amount === 1) {
            console.log('   ⏭️ Skipping current song');
            
            // Check if there's a pre-buffered song in queue
            if (queue.songs.length > 1) {
                console.log('   ✅ Pre-buffered song exists, skipping to it');
                await distube.skip(interaction.guildId);
            } else {
                console.log('   🔮 No pre-buffer, finding related song manually');
                
                // No pre-buffered song, need to find one manually
                const currentSong = queue.songs[0];
                const voiceChannel = queue.voiceChannel;
                const textChannel = queue.textChannel;
                
                // Get recently played IDs from global history
                const recentIds = getRecentHistoryIds(queue);
                console.log(`   📚 Avoiding ${recentIds.size} recently played songs`);
                
                // Get a better search query for variety
                const searchQuery = getSmartSearchQuery(currentSong, queue);
                console.log('   🔍 Smart search query:', searchQuery);
                
                // Search for related song with duplicate prevention
                const randomResult = Math.floor(Math.random() * 4) + 2;
                const relatedUrl = await searchYouTubeNoDuplicates(searchQuery, recentIds, randomResult);
                console.log('   ✅ Found related song:', relatedUrl);
                
                // Stop current and play new
                await distube.stop(interaction.guildId);
                
                // Play and immediately enable autoplay
                await distube.play(voiceChannel, relatedUrl, {
                    textChannel: textChannel,
                    member: interaction.member
                });
                
                // Enable autoplay on the new queue - try multiple times to ensure it sticks
                let retries = 0;
                const maxRetries = 5;
                const enableAutoplay = async () => {
                    const newQueue = distube.getQueue(interaction.guildId);
                    if (newQueue && !newQueue.autoplay) {
                        await distube.toggleAutoplay(interaction.guildId);
                        console.log('   🔄 Auto-play re-enabled after skip');
                        return true;
                    } else if (newQueue) {
                        console.log('   ✅ Auto-play already ON');
                        return true;
                    }
                    return false;
                };
                
                // Try immediately
                await enableAutoplay();
                
                // Also try with delays to ensure it sticks
                for (let i = 0; i < maxRetries; i++) {
                    setTimeout(async () => {
                        await enableAutoplay();
                    }, (i + 1) * 300);
                }
            }
        } else {
            console.log('   ⏭️ Jumping to song', amount);
            // Skip to specific song in queue
            await distube.jump(interaction.guildId, amount);
        }
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        
        if (amount === 1) {
            const embed = new EmbedBuilder()
                .setColor('#ff9900')
                .setTitle('⏭️ Skipped')
                .setDescription(`Skipped **${skippedSongs[0].name}**`)
                .setThumbnail(skippedSongs[0].thumbnail)
                .setFooter({ text: queue.autoplay ? 'Auto-play: ON' : '' })
                .setTimestamp();
            
            await interaction.editReply({ embeds: [embed] });
        } else {
            const embed = new EmbedBuilder()
                .setColor('#ff9900')
                .setTitle('⏭️ Skipped Multiple Songs')
                .setDescription(`Skipped **${amount} songs**`)
                .addFields(
                    { name: 'Skipped Songs', value: skippedSongs.map(song => `• ${song.name}`).join('\n'), inline: false }
                )
                .setFooter({ text: queue.autoplay ? 'Auto-play: ON' : '' })
                .setTimestamp();
            
            await interaction.editReply({ embeds: [embed] });
        }
    } catch (error) {
        console.error('Skip command error:', error);
        await interaction.editReply({
            content: `❌ Error skipping songs: ${error.message}`
        });
    }
}

async function handleStop(interaction) {
    const queue = distube.getQueue(interaction.guildId);
    
    if (!queue) {
        return interaction.reply({
            content: '❌ There is no music playing!',
            ephemeral: true
        });
    }

    try {
        await distube.stop(interaction.guildId);
        
        const embed = new EmbedBuilder()
            .setColor('#ff0000')
            .setTitle('⏹️ Stopped')
            .setDescription('Music stopped and queue cleared')
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    } catch (error) {
        await interaction.reply({
            content: `❌ Error stopping music: ${error.message}`,
            ephemeral: true
        });
    }
}

async function handleQueue(interaction) {
    const queue = distube.getQueue(interaction.guildId);
    const page = interaction.options.getInteger('page') || 1;
    const songsPerPage = 10;
    
    if (!queue || queue.songs.length === 0) {
        return interaction.reply({
            content: '❌ The queue is empty!',
            ephemeral: true
        });
    }

    const totalPages = Math.ceil(queue.songs.length / songsPerPage);
    const startIndex = (page - 1) * songsPerPage;
    const endIndex = Math.min(startIndex + songsPerPage, queue.songs.length);
    
    if (page > totalPages) {
        return interaction.reply({
            content: `❌ Page ${page} doesn't exist! There are only ${totalPages} pages.`,
            ephemeral: true
        });
    }

    const queueList = queue.songs.slice(startIndex, endIndex)
        .map((song, index) => {
            const position = startIndex + index + 1;
            const duration = song.formattedDuration;
            const requester = song.user ? song.user.toString() : 'Unknown';
            return `**${position}.** ${song.name} \`${duration}\` - ${requester}`;
        })
        .join('\n');

    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('📋 Music Queue')
        .setDescription(queueList)
        .addFields(
            { name: 'Total Songs', value: queue.songs.length.toString(), inline: true },
            { name: 'Page', value: `${page}/${totalPages}`, inline: true },
            { name: 'Volume', value: `${queue.volume}%`, inline: true }
        )
        .setTimestamp();

    if (queue.songs[0].thumbnail) {
        embed.setThumbnail(queue.songs[0].thumbnail);
    }

    await interaction.reply({ embeds: [embed] });
}

async function handleNowPlaying(interaction) {
    const queue = distube.getQueue(interaction.guildId);
    
    if (!queue || !queue.songs[0]) {
        return interaction.reply({
            content: '❌ There is no music playing!',
            flags: 64 // MessageFlags.Ephemeral
        });
    }

    const song = queue.songs[0];
    const progressBar = createProgressBar(queue.currentTime, song.duration);
    
    const embed = new EmbedBuilder()
        .setColor('#00ff00')
        .setTitle('🎵 Now Playing')
        .setDescription(`**${song.name}**`)
        .addFields(
            { name: 'Duration', value: song.formattedDuration, inline: true },
            { name: 'Requested by', value: song.user ? song.user.toString() : 'Unknown', inline: true },
            { name: 'Volume', value: `${queue.volume}%`, inline: true },
            { name: 'Progress', value: progressBar, inline: false }
        )
        .setThumbnail(song.thumbnail)
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

async function handlePause(interaction) {
    const queue = distube.getQueue(interaction.guildId);
    
    if (!queue) {
        return interaction.reply({
            content: '❌ There is no music playing!',
            ephemeral: true
        });
    }

    if (queue.paused) {
        return interaction.reply({
            content: '❌ The music is already paused!',
            ephemeral: true
        });
    }

    try {
        await distube.pause(interaction.guildId);
        
        const embed = new EmbedBuilder()
            .setColor('#ffff00')
            .setTitle('⏸️ Paused')
            .setDescription('Music has been paused')
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    } catch (error) {
        await interaction.reply({
            content: `❌ Error pausing music: ${error.message}`,
            ephemeral: true
        });
    }
}

async function handleResume(interaction) {
    const queue = distube.getQueue(interaction.guildId);
    
    if (!queue) {
        return interaction.reply({
            content: '❌ There is no music playing!',
            ephemeral: true
        });
    }

    if (!queue.paused) {
        return interaction.reply({
            content: '❌ The music is not paused!',
            ephemeral: true
        });
    }

    try {
        await distube.resume(interaction.guildId);
        
        const embed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle('▶️ Resumed')
            .setDescription('Music has been resumed')
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    } catch (error) {
        await interaction.reply({
            content: `❌ Error resuming music: ${error.message}`,
            ephemeral: true
        });
    }
}

async function handleVolume(interaction) {
    const volume = interaction.options.getInteger('amount');
    const queue = distube.getQueue(interaction.guildId);
    
    if (!queue) {
        return interaction.reply({
            content: '❌ There is no music playing!',
            ephemeral: true
        });
    }

    try {
        await distube.setVolume(interaction.guildId, volume);
        
        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('🔊 Volume Changed')
            .setDescription(`Volume set to **${volume}%**`)
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    } catch (error) {
        await interaction.reply({
            content: `❌ Error setting volume: ${error.message}`,
            ephemeral: true
        });
    }
}

async function handleShuffle(interaction) {
    const queue = distube.getQueue(interaction.guildId);
    
    if (!queue || queue.songs.length <= 1) {
        return interaction.reply({
            content: '❌ There are not enough songs in the queue to shuffle!',
            ephemeral: true
        });
    }

    try {
        await distube.shuffle(interaction.guildId);
        
        const embed = new EmbedBuilder()
            .setColor('#ff9900')
            .setTitle('🔀 Shuffled')
            .setDescription('Queue has been shuffled')
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    } catch (error) {
        await interaction.reply({
            content: `❌ Error shuffling queue: ${error.message}`,
            ephemeral: true
        });
    }
}

async function handleRepeat(interaction) {
    const mode = parseInt(interaction.options.getString('mode'));
    const queue = distube.getQueue(interaction.guildId);
    
    if (!queue) {
        return interaction.reply({
            content: '❌ There is no music playing!',
            ephemeral: true
        });
    }

    try {
        await distube.setRepeatMode(interaction.guildId, mode);
        
        const modeText = ['Off', 'Repeat Song', 'Repeat Queue'][mode];
        
        const embed = new EmbedBuilder()
            .setColor('#9900ff')
            .setTitle('🔁 Repeat Mode')
            .setDescription(`Repeat mode set to **${modeText}**`)
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    } catch (error) {
        await interaction.reply({
            content: `❌ Error setting repeat mode: ${error.message}`,
            ephemeral: true
        });
    }
}

// New Rythm-like command handlers
async function handleAutoplay(interaction) {
    const queue = distube.getQueue(interaction.guildId);
    
    if (!queue) {
        return interaction.reply({
            content: '❌ There is no music playing!',
            ephemeral: true
        });
    }

    try {
        const autoplay = !queue.autoplay;
        await distube.toggleAutoplay(interaction.guildId);
        
        const embed = new EmbedBuilder()
            .setColor(autoplay ? '#00ff00' : '#ff0000')
            .setTitle(autoplay ? '🔄 Auto-play Enabled' : '🔄 Auto-play Disabled')
            .setDescription(autoplay 
                ? 'Auto-play is now enabled. Similar songs will be added automatically when the queue ends.'
                : 'Auto-play is now disabled.'
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    } catch (error) {
        await interaction.reply({
            content: `❌ Error toggling auto-play: ${error.message}`,
            ephemeral: true
        });
    }
}

async function handleJump(interaction) {
    const queue = distube.getQueue(interaction.guildId);
    const position = interaction.options.getInteger('position');
    
    if (!queue) {
        return interaction.reply({
            content: '❌ There is no music playing!',
            ephemeral: true
        });
    }

    if (position > queue.songs.length) {
        return interaction.reply({
            content: `❌ Position ${position} doesn't exist! Queue only has ${queue.songs.length} songs.`,
            ephemeral: true
        });
    }

    // Defer reply to prevent timeout (Discord requires response within 3 seconds)
    await interaction.deferReply();

    try {
        const targetSong = queue.songs[position - 1];
        await distube.jump(interaction.guildId, position - 1);
        
        const embed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle('⏭️ Jumped to Song')
            .setDescription(`Jumped to **${targetSong.name}**`)
            .addFields(
                { name: 'Position', value: position.toString(), inline: true },
                { name: 'Duration', value: targetSong.formattedDuration, inline: true }
            )
            .setThumbnail(targetSong.thumbnail)
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        await interaction.editReply({
            content: `❌ Error jumping to song: ${error.message}`
        });
    }
}

async function handleRemove(interaction) {
    const queue = distube.getQueue(interaction.guildId);
    const position = interaction.options.getInteger('position');
    
    if (!queue) {
        return interaction.reply({
            content: '❌ There is no music playing!',
            ephemeral: true
        });
    }

    if (position > queue.songs.length) {
        return interaction.reply({
            content: `❌ Position ${position} doesn't exist! Queue only has ${queue.songs.length} songs.`,
            ephemeral: true
        });
    }

    try {
        const removedSong = queue.songs[position - 1];
        await distube.remove(interaction.guildId, position - 1);
        
        const embed = new EmbedBuilder()
            .setColor('#ff9900')
            .setTitle('🗑️ Removed Song')
            .setDescription(`Removed **${removedSong.name}** from the queue`)
            .addFields(
                { name: 'Was at position', value: position.toString(), inline: true },
                { name: 'Duration', value: removedSong.formattedDuration, inline: true }
            )
            .setThumbnail(removedSong.thumbnail)
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    } catch (error) {
        await interaction.reply({
            content: `❌ Error removing song: ${error.message}`,
            ephemeral: true
        });
    }
}

async function handleClear(interaction) {
    const queue = distube.getQueue(interaction.guildId);
    
    if (!queue) {
        return interaction.reply({
            content: '❌ There is no music playing!',
            ephemeral: true
        });
    }

    try {
        const queueLength = queue.songs.length;
        await distube.stop(interaction.guildId);
        
        const embed = new EmbedBuilder()
            .setColor('#ff0000')
            .setTitle('🗑️ Queue Cleared')
            .setDescription(`Cleared **${queueLength} songs** from the queue`)
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    } catch (error) {
        await interaction.reply({
            content: `❌ Error clearing queue: ${error.message}`,
            ephemeral: true
        });
    }
}

async function handleSeek(interaction) {
    const queue = distube.getQueue(interaction.guildId);
    const timeInput = interaction.options.getString('time');
    
    if (!queue || !queue.songs[0]) {
        return interaction.reply({
            content: '❌ There is no music playing!',
            ephemeral: true
        });
    }

    try {
        // Parse time input (supports formats: "1:30", "90", "0:45")
        let seekSeconds = 0;
        
        if (timeInput.includes(':')) {
            // Format: "1:30" or "0:45"
            const parts = timeInput.split(':');
            const minutes = parseInt(parts[0]) || 0;
            const seconds = parseInt(parts[1]) || 0;
            seekSeconds = (minutes * 60) + seconds;
        } else {
            // Format: "90" (just seconds)
            seekSeconds = parseInt(timeInput) || 0;
        }
        
        const currentSong = queue.songs[0];
        
        // Validate seek time
        if (seekSeconds < 0) {
            return interaction.reply({
                content: '❌ Seek time cannot be negative!',
                ephemeral: true
            });
        }
        
        if (seekSeconds >= currentSong.duration) {
            return interaction.reply({
                content: `❌ Seek time (${formatTime(seekSeconds)}) exceeds song duration (${currentSong.formattedDuration})!`,
                ephemeral: true
            });
        }
        
        await interaction.deferReply();
        
        console.log(`🎯 Seeking to ${formatTime(seekSeconds)} in ${currentSong.name}`);
        
        // Use DisTube's seek method
        await distube.seek(interaction.guildId, seekSeconds);
        
        const embed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle('⏩ Seeked')
            .setDescription(`Jumped to **${formatTime(seekSeconds)}** in **${currentSong.name}**`)
            .setThumbnail(currentSong.thumbnail)
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('Seek error:', error);
        await interaction.editReply({
            content: `❌ Error seeking: ${error.message || 'Failed to seek in this song'}`,
            ephemeral: true
        });
    }
}

async function handlePlayRadio(interaction) {
    let url = interaction.options.getString('url');
    const voiceChannel = interaction.member?.voice?.channel;

    await interaction.deferReply();

    try {
        // Remove surrounding quotes if present
        url = url.trim().replace(/^["']|["']$/g, '');
        
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📻 Play Radio Command Initiated');
        console.log('   User:', interaction.user.tag);
        console.log('   URL:', url);
        console.log('   Voice Channel:', voiceChannel.name);
        
        // Validate URL
        if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
            return await interaction.editReply({
                content: '❌ Please provide a valid YouTube radio/mix URL!'
            });
        }
        
        // Extract playlist videos
        const videos = await getPlaylistVideos(url, 50);
        
        if (!videos || videos.length === 0) {
            return await interaction.editReply({
                content: '❌ Could not extract videos from the radio/mix!'
            });
        }
        
        console.log(`   📻 Playing radio with ${videos.length} songs`);
        
        // Set bulk loading flag to suppress "Added to Queue" messages
        bulkLoadingGuilds.add(interaction.guildId);
        
        // Play the first song and add the rest to queue
        // Note: We intentionally don't pass 'member' so these songs are treated as auto-added
        // This allows manually added songs (via /play) to take priority in the queue
        await distube.play(voiceChannel, videos[0].url, {
            textChannel: interaction.channel
        });
        
        // Add remaining songs to queue after a delay (silently)
        setTimeout(async () => {
            try {
                for (let i = 1; i < videos.length; i++) {
                    await distube.play(voiceChannel, videos[i].url, {
                        textChannel: interaction.channel
                    });
                }
                console.log(`   ✅ All ${videos.length} songs queued from radio!`);
            } catch (error) {
                console.error('   ❌ Error adding songs to queue:', error);
            } finally {
                // Clear bulk loading flag after all songs are added
                bulkLoadingGuilds.delete(interaction.guildId);
            }
        }, 2000);
        
        // Enable autoplay
        setTimeout(async () => {
            try {
                const queue = distube.getQueue(interaction.guildId);
                if (queue && !queue.autoplay) {
                    await distube.toggleAutoplay(interaction.guildId);
                    console.log('📻 Auto-play enabled for radio');
                }
            } catch (error) {
                console.error('❌ Error enabling autoplay:', error.message);
            }
        }, 1000);
        
        const embed = new EmbedBuilder()
            .setColor('#ff6b9d')
            .setTitle('📻 YouTube Radio Started')
            .setDescription(`Loading **${videos.length} songs** from the radio mix!`)
            .addFields(
                { name: 'First Song', value: videos[0].title, inline: false },
                { name: 'Total Songs', value: videos.length.toString(), inline: true },
                { name: 'Requested by', value: interaction.user.toString(), inline: true }
            )
            .setFooter({ text: 'Auto-play enabled - will continue after playlist ends' })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    } catch (error) {
        console.error('❌ Play Radio error:', error);
        await interaction.editReply({
            content: `❌ Error playing radio: ${error.message}`
        });
    }
}

async function handlePlaylist(interaction) {
    let url = interaction.options.getString('url');
    const voiceChannel = interaction.member?.voice?.channel;

    await interaction.deferReply();

    try {
        // Remove surrounding quotes if present
        url = url.trim().replace(/^["']|["']$/g, '');
        
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📋 Playlist Command Initiated');
        console.log('   User:', interaction.user.tag);
        console.log('   URL:', url);
        console.log('   Voice Channel:', voiceChannel.name);
        
        // Validate URL
        if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
            return await interaction.editReply({
                content: '❌ Please provide a valid YouTube playlist URL!'
            });
        }
        
        // Extract playlist videos
        const videos = await getPlaylistVideos(url, 100);
        
        if (!videos || videos.length === 0) {
            return await interaction.editReply({
                content: '❌ Could not extract videos from the playlist!'
            });
        }
        
        console.log(`   📋 Playing playlist with ${videos.length} songs`);
        
        // Set bulk loading flag to suppress "Added to Queue" messages
        bulkLoadingGuilds.add(interaction.guildId);
        
        // Play the first song and add the rest to queue
        // Note: We intentionally don't pass 'member' so these songs are treated as auto-added
        // This allows manually added songs (via /play) to take priority in the queue
        await distube.play(voiceChannel, videos[0].url, {
            textChannel: interaction.channel
        });
        
        // Add remaining songs to queue after a delay (silently)
        setTimeout(async () => {
            try {
                for (let i = 1; i < videos.length; i++) {
                    await distube.play(voiceChannel, videos[i].url, {
                        textChannel: interaction.channel
                    });
                }
                console.log(`   ✅ All ${videos.length} songs queued from playlist!`);
            } catch (error) {
                console.error('   ❌ Error adding songs to queue:', error);
            } finally {
                // Clear bulk loading flag after all songs are added
                bulkLoadingGuilds.delete(interaction.guildId);
            }
        }, 2000);
        
        // Enable autoplay
        setTimeout(async () => {
            try {
                const queue = distube.getQueue(interaction.guildId);
                if (queue && !queue.autoplay) {
                    await distube.toggleAutoplay(interaction.guildId);
                    console.log('📋 Auto-play enabled for playlist');
                }
            } catch (error) {
                console.error('❌ Error enabling autoplay:', error.message);
            }
        }, 1000);
        
        const embed = new EmbedBuilder()
            .setColor('#3b88c3')
            .setTitle('📋 YouTube Playlist Loaded')
            .setDescription(`Loading **${videos.length} songs** from the playlist!`)
            .addFields(
                { name: 'First Song', value: videos[0].title, inline: false },
                { name: 'Total Songs', value: videos.length.toString(), inline: true },
                { name: 'Requested by', value: interaction.user.toString(), inline: true }
            )
            .setFooter({ text: 'Auto-play enabled - will continue after playlist ends' })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    } catch (error) {
        console.error('❌ Playlist error:', error);
        await interaction.editReply({
            content: `❌ Error loading playlist: ${error.message}`
        });
    }
}

async function handleSearch(interaction) {
    const query = interaction.options.getString('query');
    const voiceChannel = interaction.member?.voice?.channel;

    await interaction.deferReply();

    try {
        // Search for songs on YouTube
        const searchResults = await distube.search(`ytsearch5:${query}`, {
            limit: 5
        });

        if (!searchResults || searchResults.length === 0) {
            return interaction.editReply({
                content: '❌ No results found for your search!'
            });
        }

        // Create selection embed
        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('🔍 Search Results')
            .setDescription('Select a song to add to the queue:')
            .addFields(
                searchResults.map((song, index) => ({
                    name: `${index + 1}. ${song.name}`,
                    value: `Duration: ${song.formattedDuration} | Views: ${song.views?.toLocaleString() || 'N/A'}`,
                    inline: false
                }))
            )
            .setThumbnail(searchResults[0].thumbnail)
            .setTimestamp();

        const message = await interaction.editReply({ 
            embeds: [embed],
            components: [
                {
                    type: 1,
                    components: [
                        {
                            type: 3,
                            custom_id: 'search_select',
                            placeholder: 'Choose a song...',
                            options: searchResults.map((song, index) => ({
                                label: song.name.length > 100 ? song.name.substring(0, 97) + '...' : song.name,
                                description: song.formattedDuration,
                                value: index.toString()
                            }))
                        }
                    ]
                }
            ]
        });

        // Handle selection
        const filter = (i) => i.user.id === interaction.user.id && i.customId === 'search_select';
        const collector = message.createMessageComponentCollector({ filter, time: 30000 });

        collector.on('collect', async (selectInteraction) => {
            const selectedIndex = parseInt(selectInteraction.values[0]);
            const selectedSong = searchResults[selectedIndex];

            try {
                await distube.play(voiceChannel, selectedSong, {
                    textChannel: interaction.channel,
                    member: interaction.member
                });

                const successEmbed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('🎵 Added to Queue')
                    .setDescription(`**${selectedSong.name}**`)
                    .addFields(
                        { name: 'Duration', value: selectedSong.formattedDuration, inline: true },
                        { name: 'Requested by', value: interaction.user.toString(), inline: true }
                    )
                    .setThumbnail(selectedSong.thumbnail)
                    .setTimestamp();

                await selectInteraction.update({ 
                    embeds: [successEmbed],
                    components: []
                });
            } catch (error) {
                await selectInteraction.update({
                    content: `❌ Error playing song: ${error.message}`,
                    components: []
                });
            }
        });

        collector.on('end', async (collected) => {
            if (collected.size === 0) {
                await interaction.editReply({
                    content: '⏰ Search selection timed out.',
                    components: []
                });
            }
        });

    } catch (error) {
        console.error('Search command error:', error);
        await interaction.editReply({
            content: `❌ Error searching: ${error.message}`
        });
    }
}

// Helper function to create progress bar
function createProgressBar(current, total) {
    const progress = Math.round((current / total) * 20);
    const bar = '█'.repeat(progress) + '░'.repeat(20 - progress);
    const currentTime = formatTime(current);
    const totalTime = formatTime(total);
    return `${bar} \`${currentTime}/${totalTime}\``;
}

// Helper function to format time
function formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

// DisTube event handlers - Rythm style
distube.on('playSong', (queue, song) => {
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('🎵 playSong EVENT FIRED');
    logger.info(`   Song: ${song.name}`);
    logger.info(`   URL: ${song.url}`);
    logger.info(`   Duration: ${song.duration}s`);
    logger.info(`   Source: ${song.source}`);
    logger.info(`   Queue size: ${queue.songs.length}`);
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🎵 Playing song:', song.name);
    console.log('🎵 Song URL:', song.url);
    console.log('🎵 Song duration:', song.duration);
    console.log('🎵 Song format:', song.source);
    
    // Add song to global history to prevent repeats
    if (song.id) {
        addToHistory(song.id);
    }
    
    // Check if this is an autoplay song (no user or autoplay is enabled and it's the only song)
    const isAutoplay = !song.user || (queue.autoplay && queue.songs.length === 1 && queue.previousSongs.length > 0);
    
    const progressBar = createProgressBar(0, song.duration);
    const embed = new EmbedBuilder()
        .setColor(isAutoplay ? '#9c27b0' : '#00ff00')
        .setTitle(isAutoplay ? '🔮 Auto-play - Now Playing' : '🎵 Now Playing')
        .setDescription(`**${song.name}**`)
        .addFields(
            { name: 'Duration', value: song.formattedDuration, inline: true },
            { name: 'Requested by', value: song.user ? song.user.toString() : 'Auto-play', inline: true },
            { name: 'Volume', value: `${queue.volume}%`, inline: true },
            { name: 'Progress', value: progressBar, inline: false }
        )
        .setThumbnail(song.thumbnail)
        .setFooter({ text: `Queue: ${queue.songs.length} songs | Auto-play: ${queue.autoplay ? 'ON' : 'OFF'}` })
        .setTimestamp();

    // Create seek buttons for easy navigation
    const seekButtons = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('seek_-30')
                .setLabel('-30s')
                .setEmoji('⏮️')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('seek_-10')
                .setLabel('-10s')
                .setEmoji('⏪')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('seek_+10')
                .setLabel('+10s')
                .setEmoji('⏩')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('seek_+30')
                .setLabel('+30s')
                .setEmoji('⏭️')
                .setStyle(ButtonStyle.Secondary)
        );

    queue.textChannel.send({ embeds: [embed], components: [seekButtons] });
    
    // Ensure autoplay is enabled (safety check)
    if (!queue.autoplay) {
        console.log('⚠️  Autoplay is OFF, enabling it now...');
        setTimeout(async () => {
            try {
                await distube.toggleAutoplay(queue.id);
                console.log('✅ Autoplay enabled during playSong event');
            } catch (error) {
                console.error('❌ Failed to enable autoplay:', error.message);
            }
        }, 500);
    }
    
    // Smart pre-buffering: If queue only has this song, pre-load next song (regardless of autoplay state)
    if (queue.songs.length === 1) {
        console.log('🔮 Pre-buffering: Queue has only 1 song, searching for next...');
        
        // Do this asynchronously so it doesn't block
        (async () => {
            try {
                // Wait a bit before searching to let the current song start properly
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Check again if we still need to pre-buffer (user might have added a song)
                const currentQueue = distube.getQueue(queue.voiceChannel.guildId);
                if (!currentQueue || currentQueue.songs.length > 1) {
                    console.log('   ℹ️ Pre-buffer cancelled: queue changed');
                    return;
                }
                
                const currentSong = currentQueue.songs[0];
                
                // Get recently played IDs from global history
                const recentIds = getRecentHistoryIds(currentQueue);
                console.log(`   📚 Pre-buffer avoiding ${recentIds.size} recently played songs`);
                
                // Use smart search query for variety
                const searchQuery = getSmartSearchQuery(currentSong, currentQueue);
                const randomResult = Math.floor(Math.random() * 4) + 2;
                
                console.log(`   🔍 Pre-buffering: Smart search for "${searchQuery}" (result #${randomResult})`);
                const relatedUrl = await searchYouTubeNoDuplicates(searchQuery, recentIds, randomResult);
                console.log('   ✅ Pre-buffer found (unique):', relatedUrl);
                
                // Add to queue (but don't interrupt if user added something)
                const finalQueue = distube.getQueue(queue.voiceChannel.guildId);
                if (finalQueue && finalQueue.songs.length === 1) {
                    await distube.play(queue.voiceChannel, relatedUrl, {
                        textChannel: queue.textChannel,
                        skip: false // Add to queue, don't skip current song
                    });
                    console.log('   ✅ Pre-buffer song added to queue!');
                }
            } catch (error) {
                console.error('   ❌ Pre-buffer error:', error.message);
            }
        })();
    }
});

distube.on('addSong', (queue, song) => {
    // Suppress all auto-added songs (pre-buffering, autoplay)
    if (!song.user) {
        return; // Don't show messages for auto-added songs
    }
    
    // During bulk loading, still show messages for manually added songs (but simpler)
    if (bulkLoadingGuilds.has(queue.id)) {
        // Show a simple message for manual additions during bulk loading
        if (queue.songs.length > 1 && song.user) {
            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('✅ Added to Queue')
                .setDescription(`**${song.name}**\n\n*Playlist/Radio is still loading...*`)
                .setFooter({ text: `Position: ${queue.songs.length}` });
            
            queue.textChannel.send({ embeds: [embed] });
        }
        return;
    }
    
    // Only show message for manually added individual songs
    // (not the first song, to avoid duplicate with playSong event)
    if (queue.songs.length > 1 && song.user) {
        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('➕ Added to Queue')
            .setDescription(`**${song.name}**`)
            .addFields(
                { name: 'Duration', value: song.formattedDuration, inline: true },
                { name: 'Requested by', value: song.user.toString(), inline: true },
                { name: 'Position in queue', value: queue.songs.length.toString(), inline: true }
            )
            .setThumbnail(song.thumbnail)
            .setFooter({ text: `Queue: ${queue.songs.length} songs` })
            .setTimestamp();

        queue.textChannel.send({ embeds: [embed] });
    }
});

distube.on('addList', (queue, playlist) => {
    const embed = new EmbedBuilder()
        .setColor('#9900ff')
        .setTitle('📋 Playlist Added')
        .setDescription(`**${playlist.name}**`)
        .addFields(
            { name: 'Songs', value: playlist.songs.length.toString(), inline: true },
            { name: 'Duration', value: playlist.formattedDuration, inline: true },
            { name: 'Requested by', value: playlist.user ? playlist.user.toString() : 'Unknown', inline: true }
        )
        .setThumbnail(playlist.thumbnail)
        .setFooter({ text: `Queue: ${queue.songs.length} songs` })
        .setTimestamp();

    queue.textChannel.send({ embeds: [embed] });
});

distube.on('error', (error, queue) => {
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('DisTube error:', error);
    console.error('Error message:', error?.message);
    console.error('Error code:', error?.code);
    console.error('Error stack:', error?.stack);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    // Specific handling for FFmpeg errors
    if (error?.message && error.message.includes('ffmpeg exited with code')) {
        console.error('🔴 FFmpeg Error Details:');
        console.error('- Error Code:', error.message.match(/code (\d+)/)?.[1]);
        console.error('- This is likely a Windows FFmpeg compatibility issue');
        console.error('- Try using a different FFmpeg build or audio format');
    }
    
    if (queue && queue.textChannel) {
        const embed = new EmbedBuilder()
            .setColor('#ff0000')
            .setTitle('❌ Error')
            .setDescription(`An error occurred: ${error?.message || 'Unknown error'}`)
            .setTimestamp();

        queue.textChannel.send({ embeds: [embed] }).catch(console.error);
    }
});

distube.on('finish', async (queue) => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🏁 Finish event triggered (natural end)');
    console.log('   Queue exists:', !!queue);
    console.log('   Autoplay enabled:', queue?.autoplay);
    console.log('   Previous songs:', queue?.previousSongs?.length || 0);
    console.log('   Voice channel:', queue?.voiceChannel?.name);
    console.log('   Songs in queue:', queue?.songs?.length || 0);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    // Try to play next song if we have any history (regardless of autoplay state - it should have been handled by pre-buffering)
    if (queue && (queue.previousSongs?.length > 0 || globalSongHistory.size > 0)) {
        try {
            console.log('🔮 Queue finished, searching for related song (backup for pre-buffer)...');
            
            // Get a song to base the search on
            let baseSong;
            if (queue.previousSongs && queue.previousSongs.length > 0) {
                // Use the last played song
                baseSong = queue.previousSongs[queue.previousSongs.length - 1];
                console.log('🔍 Finding songs related to:', baseSong.name);
            } else if (globalSongHistory.size > 0) {
                // If no previous songs but we have global history, search generically
                console.log('🔍 No previous songs, using broad search strategy');
                baseSong = null;
            } else {
                // Absolutely nothing to base on, use generic search
                console.log('⚠️  No song history available, using generic popular music search');
                baseSong = null;
            }
            
            // Get recently played IDs from global history
            const recentIds = getRecentHistoryIds(queue);
            console.log(`   📚 Avoiding ${recentIds.size} recently played songs`);
            
            // Determine search query
            let searchQuery;
            if (baseSong) {
                // Create a temporary queue-like object for getSmartSearchQuery
                const tempQueue = {
                    songs: [],
                    previousSongs: queue.previousSongs || []
                };
                searchQuery = getSmartSearchQuery(baseSong, tempQueue);
            } else {
                // Generic popular music search
                const genericSearches = ['popular music 2024', 'top hits', 'trending music', 'best songs', 'popular songs'];
                searchQuery = genericSearches[Math.floor(Math.random() * genericSearches.length)];
            }
            console.log('🔍 Smart search query:', searchQuery);
            
            // Pick a random result (2-5) for variety
            const randomResult = Math.floor(Math.random() * 4) + 2;
            console.log(`🎲 Using search result #${randomResult}`);
            
            // Search with duplicate prevention
            const relatedUrl = await searchYouTubeNoDuplicates(searchQuery, recentIds, randomResult);
            
            console.log('✅ Found unique related song:', relatedUrl);
            
            // Play the related song (auto-added, no member property)
            // Note: We intentionally don't pass 'member' so autoplay songs are treated as auto-added
            // This allows manually added songs (via /play) to take priority in the queue
            await distube.play(queue.voiceChannel, relatedUrl, {
                textChannel: queue.textChannel
            });
            
            // Re-enable autoplay on the new queue (it might get disabled after finish event)
            setTimeout(async () => {
                const newQueue = distube.getQueue(queue.voiceChannel.guildId);
                if (newQueue && !newQueue.autoplay) {
                    await distube.toggleAutoplay(queue.voiceChannel.guildId);
                    console.log('   🔄 Auto-play re-enabled after finish event');
                }
            }, 1000);
        } catch (error) {
            console.error('❌ Auto-play error:', error);
            console.error('Error stack:', error.stack);
            
            const embed = new EmbedBuilder()
                .setColor('#ff9900')
                .setTitle('🏁 Queue Finished')
                .setDescription('All songs have been played. Could not find related songs for auto-play.')
                .setTimestamp();

            if (queue && queue.textChannel) {
                queue.textChannel.send({ embeds: [embed] });
            }
        }
    } else {
        // Auto-play is disabled or no previous songs
        console.log('   ℹ️ Auto-play disabled or no previous songs - queue ending');
        const embed = new EmbedBuilder()
            .setColor('#ff9900')
            .setTitle('🏁 Queue Finished')
            .setDescription('All songs have been played')
            .setTimestamp();

        if (queue && queue.textChannel) {
            queue.textChannel.send({ embeds: [embed] });
        }
    }
});

distube.on('disconnect', (queue) => {
    const embed = new EmbedBuilder()
        .setColor('#ff0000')
        .setTitle('🔌 Disconnected')
        .setDescription('Left the voice channel')
        .setTimestamp();

    queue.textChannel.send({ embeds: [embed] });
});

// Additional Rythm-like event handlers
distube.on('searchNoResult', (message, query) => {
    const embed = new EmbedBuilder()
        .setColor('#ff0000')
        .setTitle('❌ No Results Found')
        .setDescription(`No results found for: **${query}**`)
        .setTimestamp();

    message.channel.send({ embeds: [embed] });
});

distube.on('searchInvalidAnswer', (message) => {
    const embed = new EmbedBuilder()
        .setColor('#ff9900')
        .setTitle('⚠️ Invalid Selection')
        .setDescription('Please provide a valid number between 1 and 10.')
        .setTimestamp();

    message.channel.send({ embeds: [embed] });
});

distube.on('searchCancel', (message) => {
    const embed = new EmbedBuilder()
        .setColor('#ff9900')
        .setTitle('⏹️ Search Cancelled')
        .setDescription('Song search was cancelled.')
        .setTimestamp();

    message.channel.send({ embeds: [embed] });
});

distube.on('searchDone', (message, answer, query) => {
    const embed = new EmbedBuilder()
        .setColor('#00ff00')
        .setTitle('✅ Search Complete')
        .setDescription(`Selected: **${answer.name}**`)
        .setTimestamp();

    message.channel.send({ embeds: [embed] });
});

// Error handling - Fatal errors will stop the service
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    console.error('Uncaught Exception:', error);
    
    // Give logger time to write, then exit (service will stop and not restart)
    setTimeout(() => {
        logger.error('Bot shutting down due to uncaught exception');
        process.exit(1);
    }, 1000);
});

// Graceful shutdown handlers
process.on('SIGTERM', () => {
    logger.info('SIGTERM received. Shutting down gracefully...');
    console.log('SIGTERM received. Shutting down gracefully...');
    client.destroy();
    setTimeout(() => process.exit(0), 1000);
});

process.on('SIGINT', () => {
    logger.info('SIGINT received. Shutting down gracefully...');
    console.log('SIGINT received. Shutting down gracefully...');
    client.destroy();
    setTimeout(() => process.exit(0), 1000);
});

// Start the bot
logger.info('Logging in to Discord...');
client.login(process.env.DISCORD_TOKEN).catch(error => {
    logger.error('Failed to login to Discord:', error);
    console.error('Failed to login to Discord:', error);
    process.exit(1);
});
