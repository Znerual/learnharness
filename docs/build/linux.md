# Build on Linux

This guide builds LearnHarness with Vault on a Linux PC with [`scripts/vault-linux-build.sh`](../../scripts/vault-linux-build.sh).
The result is an AppImage, which runs on most distributions, and optionally a `.deb` package for
Debian, Ubuntu and their derivatives.

## What you need

- A PC with an x64 processor (Intel or AMD). ARM computers are not supported.
- A current distribution, for example Ubuntu 24.04, Debian 13 or Fedora 42.
- About 10 GB of free disk space and a good internet connection.
- git, curl and Node 26 with npm.

### Install the tools

git and curl come from your distribution:

```sh
sudo apt install git curl            # Debian, Ubuntu
sudo dnf install git curl            # Fedora
```

Node 26 is usually newer than the one in your distribution. Install it with nvm, which needs no
administrator rights:

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# open a new terminal, then:
nvm install 26
node -v                              # prints v26.x
```

Other ways to get Node 26 are listed at https://nodejs.org/en/download.

The AppImage needs FUSE 2 to start. Most desktops have it. On Ubuntu 24.04 and newer, install it
with `sudo apt install libfuse2t64`; on older Ubuntu and Debian, with `sudo apt install libfuse2`.

## Build

Copy the command for the current version from the download page
(https://learn-vault.ddns.net/#get-the-app, tab "Linux") and run it in a terminal. It looks like
this:

```sh
curl -fsSLO https://raw.githubusercontent.com/Znerual/learnharness/vault-<version>/scripts/vault-linux-build.sh && bash vault-linux-build.sh --version <version> --ref vault-<version>
```

The script downloads the code into `~/learnharness-vault-linux` and builds the app. When it is done,
it prints the SHA-256 checksums and the folder with the result:

```
~/learnharness-vault-linux/dist-vault/learnharness-linux.AppImage
~/learnharness-vault-linux/dist-vault/version.txt
```

### Options

Add these to the end of the command:

| Option | Effect |
| --- | --- |
| `--deb` | Also build `learnharness-linux.deb` for Debian and Ubuntu. |
| `--no-updates` | Turn in-app updates off (see [Updates](#updates)). |
| `--dir DIR` | Keep the build checkout in `DIR` instead of `~/learnharness-vault-linux`. |
| `--out DIR` | Put the result in `DIR`. |
| `--host NAME` | Build for another vault server, `https://NAME`. Only for people who run their own vault. |
| `--help` | Show all options. |

## Install

### AppImage

Move the AppImage to a fixed place with a name that has no version number, so updates replace it
in place:

```sh
mkdir -p ~/Applications
mv ~/learnharness-vault-linux/dist-vault/learnharness-linux.AppImage ~/Applications/LearnHarness.AppImage
~/Applications/LearnHarness.AppImage
```

To get a menu entry, use your desktop's AppImage integration (for example Gear Lever or
AppImageLauncher), or create one by hand.

### .deb

If you built with `--deb`:

```sh
sudo apt install ~/learnharness-vault-linux/dist-vault/learnharness-linux.deb
```

LearnHarness then appears in the application menu.

## Sign in to the vault

Open LearnHarness, then Settings, Vault, and sign in with the email and password of your vault
account. If you do not have an account yet, create one at https://learn-vault.ddns.net/signup/.

## Updates

By default the app updates itself from the vault server's update feed. That feed holds the
published builds, so the next update replaces your own build with the published one of the newer
version. The AppImage replaces its file in place. The `.deb` asks for your administrator password
to install the update.

If you want to run only builds you made yourself, build with `--no-updates`. The app then never
updates itself. For a new version, run the new version's command from the download page and
install the result over the old one.

## Your data

Sessions, notes, settings and API keys are stored in `~/.config/LearnHarness`. Building and
installing a new version does not touch that folder.

## Troubleshooting

- **"needs Node 26 or newer"**: run `nvm install 26` (or `nvm use 26`) in the same terminal, then
  run the command again.
- **"has local changes"**: the build folder was edited. Reset it with
  `git -C ~/learnharness-vault-linux checkout -- .` or pass another `--dir`.
- **"no branch or tag 'vault-…'"**: the version in the command does not exist. Copy the command
  again from the download page.
- **The AppImage does not start and mentions FUSE**: install FUSE 2 (see [Install the tools](#install-the-tools)).
- **The build stops with "out of memory"**: close other programs. The build needs about 4 GB of
  free memory.
- **The build fails in `npm ci`**: check the internet connection and run the command again. The
  script continues from the same checkout.

## Uninstall

Delete `~/Applications/LearnHarness.AppImage`, or run `sudo apt remove learnharness` for the
`.deb`. Delete `~/learnharness-vault-linux` to remove the build checkout. Delete
`~/.config/LearnHarness` only if you also want to remove your data; with a vault account, your
records stay in the vault.
