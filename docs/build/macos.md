# Build on macOS

This guide builds LearnHarness with Vault on a Mac with [`scripts/vault-mac-build.sh`](../../scripts/vault-mac-build.sh).
There is no published Mac app of LearnHarness with Vault: a Mac app from a download would need an
Apple Developer ID to open without warnings, so Mac users build it themselves. The result is a DMG
disk image with the app.

## What you need

- A Mac with Apple silicon (M1 or newer). Intel Macs are not supported.
- macOS 26 or newer.
- Xcode 26 or newer. The Command Line Tools alone are not enough: the build compiles the app icon
  with Xcode's `actool`.
- About 10 GB of free disk space for the build, plus about 15 GB for Xcode, and a good internet
  connection.
- git and Node 26 with npm.

### Install the tools

1. Install Xcode from the App Store. Open it once and accept the license, then quit it.
2. git comes with Xcode. Check it in Terminal with `git --version`.
3. Install Node 26, either with the installer from https://nodejs.org/en/download, or with
   Homebrew:

   ```sh
   brew install node@26
   ```

   Check it with `node -v`; it prints `v26.x`.

If you have more than one Xcode, the script uses `/Applications/Xcode.app`. Set `DEVELOPER_DIR`
to use another one.

## Build

Copy the command for the current version from the download page
(https://learn-vault.ddns.net/#get-the-app, tab "macOS") and run it in Terminal. It looks like
this:

```sh
curl -fsSLO https://raw.githubusercontent.com/Znerual/learnharness/vault-<version>/scripts/vault-mac-build.sh && bash vault-mac-build.sh --version <version> --ref vault-<version>
```

The script downloads the code into `~/learnharness-vault-mac` and builds the app. When it is done,
it prints the SHA-256 checksum and the folder with the result:

```
~/learnharness-vault-mac/dist-vault/learnharness-macos.dmg
~/learnharness-vault-mac/dist-vault/version.txt
```

### Options

Add these to the end of the command:

| Option | Effect |
| --- | --- |
| `--dir DIR` | Keep the build checkout in `DIR` instead of `~/learnharness-vault-mac`. |
| `--out DIR` | Put the result in `DIR`. |
| `--host NAME` | Build for another vault server, `https://NAME`. Only for people who run their own vault. |
| `--help` | Show all options. |

## Install

1. Open `~/learnharness-vault-mac/dist-vault/learnharness-macos.dmg`.
2. Drag LearnHarness into Applications, replacing an older version if asked.
3. Open LearnHarness from Applications.

The app is signed only ad hoc, not with an Apple Developer ID, so macOS asks before it opens it the
first time. If macOS says the app cannot be opened, open System Settings, Privacy & Security, and
click "Open Anyway" next to LearnHarness. If that does not help, run this in Terminal and open the
app again:

```sh
xattr -dr com.apple.quarantine /Applications/LearnHarness.app
```

## Sign in to the vault

Open LearnHarness, then Settings, Vault, and sign in with the email and password of your vault
account. If you do not have an account yet, create one at https://learn-vault.ddns.net/signup/.

## Updates

The Mac app does not update itself: macOS cannot update an app that is signed only ad hoc. For a
new version, run the new version's command from the download page and drag the new app into
Applications, replacing the old one. Settings, General shows the version you run and links to the
release notes.

## Your data

Sessions, notes, settings and API keys are stored in `~/Library/Application Support/LearnHarness`.
Replacing the app does not touch that folder.

## Troubleshooting

- **"needs Xcode 26+"**: install Xcode from the App Store and open it once. If it is installed
  somewhere other than `/Applications/Xcode.app`, set `DEVELOPER_DIR`, for example
  `export DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer`.
- **"needs Node 26 or newer"**: install Node 26 (see [Install the tools](#install-the-tools)). With
  Homebrew, `brew link --overwrite node@26` makes it the default `node`.
- **"needs Apple Silicon"**: Intel Macs cannot build or run this app.
- **"has local changes"**: the build folder was edited. Reset it with
  `git -C ~/learnharness-vault-mac checkout -- .` or pass another `--dir`.
- **"no branch or tag 'vault-…'"**: the version in the command does not exist. Copy the command
  again from the download page.
- **The build fails in `npm ci`**: check the internet connection and run the command again.

## Uninstall

Drag LearnHarness from Applications to the Trash. Delete `~/learnharness-vault-mac` to remove the
build checkout. Delete `~/Library/Application Support/LearnHarness` only if you also want to
remove your data; with a vault account, your records stay in the vault.
