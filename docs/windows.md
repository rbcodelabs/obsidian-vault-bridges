# Windows Notes

Vault Bridges uses file copying (via Node's `fs.cpSync`) rather than symlinks or junction points. This means Windows works identically to macOS and Linux — no Developer Mode, no admin rights, and no `mklink` required.

---

## Git in PATH

Vault Bridges runs `git pull` and `git push` using the system `git` command. On Windows, Git may not be in your PATH depending on how it was installed.

To verify:
1. Open **Command Prompt** or **PowerShell**
2. Run `git --version`

If you get an error, either:

**Option A: Add Git to PATH during install**
When installing [Git for Windows](https://git-scm.com/download/win), choose "Git from the command line and also from 3rd-party software" when prompted.

**Option B: Add Git to PATH manually**
1. Find your Git install (commonly `C:\Program Files\Git\bin\`)
2. Open **System Properties → Environment Variables**
3. Edit the `Path` variable under System Variables
4. Add `C:\Program Files\Git\bin` (or wherever `git.exe` lives)
5. Restart Obsidian

---

## Path Format

On Windows, repo paths should use backslashes or forward slashes — either works:

```
C:\Users\you\projects\my-docs
C:/Users/you/projects/my-docs
```

Both formats are accepted.

---

## OneDrive, Dropbox, and Cloud Sync

If your Obsidian vault lives in a OneDrive or Dropbox folder, be aware that cloud sync tools may interfere with bridged files. Because the vault now contains real copied files (not junction points), cloud sync will actually index and upload the bridged content — which is usually fine, but can cause issues:

- **Sync conflicts:** If you edit bridged files on two machines and don't Push/Pull between sessions, cloud sync may create conflict copies
- **Performance:** Large bridged repos (many files) will be uploaded to cloud storage, which may be slow or exceed quotas
- **Re-sync on Pull:** Every Pull overwrites bridge files with repo contents, which triggers cloud sync to re-upload changed files

If this is a concern, consider placing your vault outside a synced folder, or excluding bridge destination paths from cloud sync via your provider's selective sync settings.

---

## Long Paths

If your repo or vault path is deeply nested and exceeds 260 characters total, Windows may refuse to create files. To enable long path support:

1. Run the following in an **admin** terminal:
   ```
   git config --system core.longpaths true
   ```
2. Enable long paths in Windows itself via Group Policy or registry (search "Enable Win32 long paths" for your Windows version)

---

## Reporting Windows Issues

If you encounter a Windows-specific issue not covered here, please [open a GitHub issue](https://github.com/rbcodelabs/obsidian-vault-bridges/issues) with:
- Your Windows version
- The exact error message from the Vault Bridges settings panel or developer console
- Steps to reproduce
