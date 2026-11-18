# Build on Windows

This guide builds LearnHarness with Vault on a Windows PC with [`scripts/vault-windows-build.ps1`](../../scripts/vault-windows-build.ps1).
The result is the same kind of installer as the published Windows download.

## What you need

- A PC with an x64 processor (Intel or AMD) and Windows 10 or 11. Windows on ARM is not
  supported.
- About 10 GB of free disk space and a good internet connection.
- git and Node 26 with npm.

### Install the tools

Open PowerShell and install both with winget:

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS -e
```

Or use the installers from https://git-scm.com/download/win and https://nodejs.org/en/download.
Install Node 26 or newer. Close PowerShell and open a new window afterwards, then check both:

```powershell
git --version
node -v        # prints v26.x
```

## Build

Copy the command for the current version from the download page
(https://learn-vault.ddns.net/#get-the-app, tab "Windows") and run it in PowerShell. It looks like
this:

```powershell
irm https://raw.githubusercontent.com/Znerual/learnharness/vault-<version>/scripts/vault-windows-build.ps1 -OutFile vault-windows-build.ps1; powershell -ExecutionPolicy Bypass -File vault-windows-build.ps1 -Version <version> -Ref vault-<version>
```

`-ExecutionPolicy Bypass` lets this one script run without changing the execution policy of your
PC. The script downloads the code into `%USERPROFILE%\learnharness-vault-win` and builds the app.
When it is done, it prints the SHA-256 checksum and the folder with the result:

```
%USERPROFILE%\learnharness-vault-win\dist-vault\LearnHarness-<version>-x64-setup.exe
%USERPROFILE%\learnharness-vault-win\dist-vault\latest.yml
%USERPROFILE%\learnharness-vault-win\dist-vault\version.txt
```

### Options

Add these to the end of the command:

| Option | Effect |
| --- | --- |
| `-Dir DIR` | Keep the build checkout in `DIR` instead of `%USERPROFILE%\learnharness-vault-win`. |
| `-Out DIR` | Put the result in `DIR`. |
| `-VaultHost NAME` | Build for another vault server, `https://NAME`. Only for people who run their own vault. |

## Install

Run `LearnHarness-<version>-x64-setup.exe` from the result folder. It installs for your user only
and needs no administrator rights.

The installer is not code-signed, so Windows SmartScreen warns the first time. Click "More info",
then "Run anyway".

## Sign in to the vault

Open LearnHarness, then Settings, Vault, and sign in with the email and password of your vault
account. If you do not have an account yet, create one at https://learn-vault.ddns.net/signup/.

## Updates

The app updates itself from the vault server's update feed. That feed holds the published builds,
so the next update replaces your own build with the published one of the newer version. To stay on
builds you make yourself, turn off automatic updates in Settings, General, and for a new version
run the new version's command from the download page and run the new installer.

## Your data

Sessions, notes, settings and API keys are stored in `%APPDATA%\LearnHarness`. Installing a new
version does not touch that folder.

## Troubleshooting

- **"running scripts is disabled on this system"**: run the script with
  `powershell -ExecutionPolicy Bypass -File vault-windows-build.ps1 …`, as in the command above.
- **"needs git on PATH" or "needs node on PATH"**: install the tools, then open a new PowerShell
  window so it sees them.
- **"needs Node 26 or newer"**: install Node 26 or newer, then open a new PowerShell window.
- **"has local changes"**: the build folder was edited. Reset it with
  `git -C $HOME\learnharness-vault-win checkout -- .` or pass another `-Dir`.
- **"no branch or tag 'vault-…'"**: the version in the command does not exist. Copy the command
  again from the download page.
- **The build fails with a path that is too long**: enable long paths once in an administrator
  PowerShell with
  `New-ItemProperty -Path HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force`,
  or pass a short `-Dir`, for example `-Dir C:\lhb`.
- **Antivirus software slows the build down or blocks files**: exclude the build folder from
  real-time scanning while it builds.

## Uninstall

Open Settings, Apps, Installed apps, and uninstall LearnHarness. Delete
`%USERPROFILE%\learnharness-vault-win` to remove the build checkout. Delete
`%APPDATA%\LearnHarness` only if you also want to remove your data; with a vault account, your
records stay in the vault.
