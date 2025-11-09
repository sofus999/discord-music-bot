# Windows Service Setup Guide

## 🎉 Your Discord Music Bot is now ready to run as a Windows Service!

---

## 📦 Installation

### Step 1: Install the Service (Run as Administrator)

**IMPORTANT:** You MUST run PowerShell or Command Prompt as Administrator!

```powershell
# Right-click PowerShell/Terminal -> "Run as Administrator"
cd "C:\Users\stefa\OneDrive\Dokumenter\Projects\Disc"
npm run install-service
```

This will:
- ✅ Install the bot as a Windows Service named "Discord Music Bot"
- ✅ Configure it to NOT auto-restart on errors (as requested)
- ✅ Set up proper logging

---

## 🚀 Starting the Service

### Option 1: Via services.msc (GUI)
1. Press `Win + R`, type `services.msc`, press Enter
2. Find "Discord Music Bot" in the list
3. Right-click → **Start**

### Option 2: Via Command Line
```powershell
net start "Discord Music Bot"
```

---

## 🛑 Stopping the Service

### Option 1: Via services.msc
1. Open `services.msc`
2. Find "Discord Music Bot"
3. Right-click → **Stop**

### Option 2: Via Command Line
```powershell
net stop "Discord Music Bot"
```

---

## ⚙️ Service Configuration

### Set Startup Type
1. Open `services.msc`
2. Find "Discord Music Bot" → Right-click → **Properties**
3. **Startup type:**
   - **Automatic** - Starts with Windows
   - **Manual** - Start manually when needed (recommended)
   - **Disabled** - Prevent starting

### Recovery Options
The service is configured with `maxRestarts: 0`, meaning:
- ❌ **Will NOT auto-restart** if it crashes
- ✅ **Service will stop** and stay stopped
- ✅ **Must manually restart** after fixing errors
- ✅ **Check logs** to see what went wrong

---

## 📝 Logging

All logs are saved in the `logs/` folder:

### Log Files
- **`logs/bot-YYYY-MM-DD.log`** - General logs (info, warnings, errors)
- **`logs/error-YYYY-MM-DD.log`** - Error logs only

### Log Rotation
- Daily rotation (new file each day)
- Keeps 14 days of general logs
- Keeps 30 days of error logs
- Auto-deletes old logs

### View Logs
```powershell
# View today's log
type logs\bot-2025-01-09.log

# View error log
type logs\error-2025-01-09.log

# Real-time monitoring (PowerShell)
Get-Content logs\bot-2025-01-09.log -Wait -Tail 50
```

---

## 🔧 Service Management Commands

```powershell
# Check service status
sc query "Discord Music Bot"

# View service details
Get-Service "Discord Music Bot" | Format-List *

# Start service
net start "Discord Music Bot"

# Stop service
net stop "Discord Music Bot"

# Uninstall service (as Administrator)
npm run uninstall-service
```

---

## 🐛 Troubleshooting

### Service won't install
**Problem:** "Access denied" or permission errors  
**Solution:** Run PowerShell/Terminal as Administrator

### Service won't start
**Problem:** Service stops immediately  
**Solution:**
1. Check `logs/error-*.log` for details
2. Ensure `.env` file exists with valid `DISCORD_TOKEN`
3. Verify all dependencies: `npm install`
4. Test manually first: `npm start`

### Bot gets stuck on "thinking" when playing music
**Problem:** `/play` command hangs, never responds, no music plays  
**Common Causes:**
1. Voice connection timeout when running as service
2. FFMPEG not accessible by service account
3. Native modules not rebuilt after copying files

**Solutions:**

**Step 1: Run diagnostics**
```powershell
node test-service.js
```
Check for any red ❌ marks in the output.

**Step 2: Stop the service and test manually**
```powershell
# Stop service
net stop "Discord Music Bot"

# Test manually (should work)
npm start
```

If it works manually but not as a service, continue to Step 3.

**Step 3: Check service logs**
```powershell
# Check for timeout errors
type logs\error-*.log | findstr "timeout"

# Check for FFMPEG errors
type logs\error-*.log | findstr "ffmpeg"
```

**Step 4: Rebuild and reinstall**
```powershell
# Stop service
net stop "Discord Music Bot"

# Uninstall service (as Administrator)
npm run uninstall-service

# Rebuild native modules
npm rebuild

# Reinstall service (as Administrator)
npm run install-service

# Start service
net start "Discord Music Bot"
```

**Step 5: Check service account permissions**

The service might be running under `SYSTEM` or `NETWORK SERVICE` account which may not have access to certain resources.

1. Open `services.msc`
2. Find "Discord Music Bot" → Right-click → **Properties**
3. Go to **Log On** tab
4. Try changing from "Local System account" to "This account" with your Windows account
5. Enter your password
6. Click OK and restart the service

**Step 6: Increase timeout (if still hanging)**

Edit `index.js` line ~929 and increase timeout from 30000 (30s) to 60000 (60s):
```javascript
setTimeout(() => reject(new Error('Play operation timed out after 60 seconds')), 60000);
```

### View Windows Event Logs
1. Press `Win + R`, type `eventvwr.msc`
2. Navigate to: **Windows Logs** → **Application**
3. Look for entries from "Discord Music Bot"

### Service Status shows "Stopped"
This is expected if:
- ✅ You manually stopped it
- ✅ Bot encountered a fatal error (by design - check logs!)
- ✅ Windows restarted

### Clear Old Logs
```powershell
# Delete logs older than 30 days
Get-ChildItem logs\*.log -Recurse | Where-Object {$_.LastWriteTime -lt (Get-Date).AddDays(-30)} | Remove-Item
```

---

## 🔄 Updating the Bot

If you make changes to `index.js`:

1. **Stop the service**
   ```powershell
   net stop "Discord Music Bot"
   ```

2. **Uninstall the service** (as Administrator)
   ```powershell
   npm run uninstall-service
   ```

3. **Reinstall the service** (as Administrator)
   ```powershell
   npm run install-service
   ```

4. **Start the service**
   ```powershell
   net start "Discord Music Bot"
   ```

---

## 📊 Service Behavior

### When Service is Running:
- ✅ Bot is online in Discord
- ✅ Responds to `/play` and other commands
- ✅ All activity logged to `logs/bot-*.log`
- ✅ Errors logged to `logs/error-*.log`

### When Fatal Error Occurs:
- ❌ Service stops immediately
- ❌ Does NOT auto-restart (by design)
- ✅ Error logged before shutdown
- ✅ Check `logs/error-*.log` for details
- ⚠️ Must manually start after fixing issue

### Graceful Shutdown (Stop Service):
- ✅ Disconnects from Discord cleanly
- ✅ Logs shutdown message
- ✅ Closes all connections

---

## 🎯 Quick Start Checklist

- [ ] Install service as Administrator: `npm run install-service`
- [ ] Open `services.msc` and find "Discord Music Bot"
- [ ] Set **Startup type** to "Manual" or "Automatic"
- [ ] Start the service
- [ ] Check `logs/bot-*.log` to verify it started
- [ ] Test with `/play` command in Discord
- [ ] Service stays running even after you log out!

---

## ✅ Service Benefits

1. **Runs in background** - Even when you're not logged in
2. **Auto-start option** - Can start with Windows
3. **Centralized management** - Control via services.msc
4. **Professional logging** - Daily rotating logs
5. **Controlled restart** - Won't restart on errors (prevents spam)
6. **System integration** - Managed like any Windows service

---

## 📞 Need Help?

If service won't start or stops unexpectedly:
1. Check `logs/error-*.log`
2. Try running manually: `npm start`
3. Check Windows Event Viewer
4. Verify Discord token in `.env`

---

**Service Name:** Discord Music Bot  
**Service Description:** Discord music bot with DisTube integration  
**Auto-Restart:** Disabled (by design)  
**Logs Location:** `./logs/`

Happy listening! 🎵

