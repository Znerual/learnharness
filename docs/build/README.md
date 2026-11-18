# Build LearnHarness with Vault from source

You can build the desktop app yourself from the public source in this repository instead of
downloading an installer. The build includes LearnHarness Vault, the end-to-end encrypted sync
service, and works the same as the published app.

One script per operating system does the whole build. It checks your computer, downloads the
code, builds the app and tells you where the result is:

| Operating system | Script | Guide |
| --- | --- | --- |
| Linux (x64) | [`scripts/vault-linux-build.sh`](../../scripts/vault-linux-build.sh) | [Linux](linux.md) |
| macOS (Apple silicon) | [`scripts/vault-mac-build.sh`](../../scripts/vault-mac-build.sh) | [macOS](macos.md) |
| Windows (x64) | [`scripts/vault-windows-build.ps1`](../../scripts/vault-windows-build.ps1) | [Windows](windows.md) |

There is no build from source for Android. Use the published Android app.

## Which version to build

Each Vault release has a tag `vault-<version>` in this repository, for example `vault-0.6.2103`.
The download page of the vault site (https://learn-vault.ddns.net/#get-the-app) shows the command
for the current version, with the version already filled in. Copy the command from there. The
guides write the version as `<version>`.

Build the version that the download page shows. The vault server and the app of one release are
tested together.

## What all three builds have in common

- The build needs Node 26 with npm, git, a good internet connection and about 10 GB of free disk
  space. It takes between 5 and 20 minutes, depending on the computer.
- The script keeps its own copy of the code in a build folder in your home folder. It resets that
  folder to the requested version on every run, so do not edit files there.
- Your sessions, notes and settings are not in the build folder. They live in the app's data
  folder (see each guide) and stay when you build and install a new version.
- The app is not code-signed. Your operating system warns about it the first time you open it.
  Each guide says how to continue.
- The scripts never ask for administrator rights. Installing the result may ask for them.
