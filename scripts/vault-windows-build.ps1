<#
Build the vault Windows app on a Windows PC: the LearnHarness desktop app with a vault server built
in, for the vault host's download page and update feed. The PC fetches the code itself (the repo is
public, no login):

  irm https://raw.githubusercontent.com/Znerual/learnharness/main/scripts/vault-windows-build.ps1 -OutFile vault-windows-build.ps1
  powershell -ExecutionPolicy Bypass -File vault-windows-build.ps1 -Version 0.4.2112

or, from a checkout: powershell -ExecutionPolicy Bypass -File scripts\vault-windows-build.ps1 -Version 0.4.2112 -Here

Parameters:
  -Version X.Y.Z    required; the same number as the Linux, Android and Mac vault builds of the release
  -VaultHost NAME   vault host built in as https://NAME (default learn-vault.ddns.net)
  -Ref REF          branch or tag to build (default main); ignored with -Here
  -Dir DIR          where the build checkout lives (default ~\learnharness-vault-win); cloned on the
                    first run, reset to origin/REF on every later run (local changes there are refused)
  -Here             build the checkout this script is in, as it is
  -Out DIR          where the result goes (default <checkout>\dist-vault)
  -CopyTo TARGET    scp the result there afterwards, e.g. laurenz@build-pc.local:lhv-win/

Result in -Out: LearnHarness-<version>-x64-setup.exe, latest.yml and version.txt, the shape
learnharness-vault's deploy/lan/release-vault-build.sh takes (--win-dir DIR). The installer goes to
the download page as learnharness-windows.exe, and the installer with latest.yml to the update feed
https://<host>/updates/, so installed apps update themselves.

Needs: Windows x64, Node 26 with npm, git (and OpenSSH's scp for -CopyTo, built into Windows). The
installer is not code-signed (electron-builder.yml): SmartScreen warns on the first install, and
updates work without a signature (verifyUpdateCodeSignature: false).

Keep this file ASCII only: Windows PowerShell 5.1 reads a script without a byte order mark as ANSI.
#>
param(
	[string]$Version = "",
	[string]$VaultHost = "learn-vault.ddns.net",
	[string]$Ref = "main",
	[string]$Dir = (Join-Path $HOME "learnharness-vault-win"),
	[switch]$Here,
	[string]$Out = "",
	[string]$CopyTo = ""
)

$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/Znerual/learnharness.git"

function Fail([string]$Message) {
	Write-Host "vault-windows-build: $Message" -ForegroundColor Red
	exit 1
}

# Runs a native command and stops on a non-zero exit code (Windows PowerShell 5.1 does not). A
# plain function on purpose: an advanced one would take "-C" or "--quiet" as its own parameters.
# Native stderr is never redirected here: with ErrorActionPreference Stop, Windows PowerShell 5.1
# turns redirected stderr lines into terminating errors.
function Run {
	$command = $args[0]
	$rest = @($args | Select-Object -Skip 1)
	& $command @rest
	if ($LASTEXITCODE -ne 0) { Fail "$command $($rest -join ' ') failed (exit $LASTEXITCODE)" }
}

# UTF-8 without a byte order mark (Set-Content -Encoding utf8 writes one in Windows PowerShell 5.1).
function Write-Utf8([string]$Path, [string]$Text) {
	[System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { Fail "-Version must be plain X.Y.Z (got '$Version')" }
if ($VaultHost -notmatch '^[A-Za-z0-9.-]+$') { Fail "-VaultHost must be a bare host name (got '$VaultHost')" }
if ($Ref -notmatch '^[A-Za-z0-9._/-]+$') { Fail "-Ref has unexpected characters: $Ref" }

# -- the machine ---------------------------------------------------------------
if ($env:OS -ne "Windows_NT") { Fail "this builds the Windows app and runs only on Windows" }
if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64") { Fail "needs an x64 PC (the app is built for x64); this one is $env:PROCESSOR_ARCHITECTURE" }
foreach ($tool in "git", "node", "npm", "npx") {
	if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Fail "needs $tool on PATH (Node 26 with npm from nodejs.org, git from git-scm.com)" }
}
$nodeVersion = (& node -p "process.versions.node").Trim()
if ([int]($nodeVersion.Split(".")[0]) -lt 26) { Fail "needs Node 26 or newer (the release builds use 26); found $nodeVersion" }
if ($CopyTo -and -not (Get-Command scp -ErrorAction SilentlyContinue)) { Fail "-CopyTo needs scp (Settings, Optional features, OpenSSH Client)" }
Write-Host "== Windows: $([System.Environment]::OSVersion.VersionString), Node $nodeVersion"

# -- the code ------------------------------------------------------------------
if ($Here) {
	$checkout = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
	if (-not (Test-Path (Join-Path $checkout "electron\main.cjs"))) { Fail "-Here: $checkout is not a learnharness checkout" }
	$head = (& git -C $checkout rev-parse --short HEAD)
	Write-Host "== code: this checkout ($checkout, $head)"
} else {
	$checkout = $Dir
	if (-not (Test-Path (Join-Path $checkout ".git"))) {
		Write-Host "== code: cloning $RepoUrl into $checkout"
		Run git clone --quiet $RepoUrl $checkout
	}
	$dirty = (& git -C $checkout status --porcelain --untracked-files=no)
	if ($dirty) { Fail "$checkout has local changes; it is a build checkout, reset it (git -C '$checkout' checkout -- .) or pass another -Dir" }
	Run git -C $checkout fetch --quiet --tags --force origin
	$remoteRef = (& git -C $checkout rev-parse --verify --quiet "refs/remotes/origin/$Ref")
	if ($LASTEXITCODE -eq 0 -and $remoteRef) {
		Run git -C $checkout checkout --quiet --detach "origin/$Ref"
	} else {
		& git -C $checkout checkout --quiet --detach $Ref
		if ($LASTEXITCODE -ne 0) { Fail "no branch or tag '$Ref' in $RepoUrl" }
	}
	Write-Host "== code: $Ref at $(& git -C $checkout rev-parse --short HEAD)"
}
if (-not $Out) { $Out = Join-Path $checkout "dist-vault" }
Set-Location $checkout

# -- build ---------------------------------------------------------------------
Write-Host "== npm ci"
Run npm ci --no-audit --no-fund

foreach ($d in "dist", ".next\standalone") { if (Test-Path $d) { Remove-Item -Recurse -Force $d } }
Write-Host "== next build ($Version, vault https://$VaultHost)"
# Settings, General shows this number and links "Release notes" to the vault host's page.
$env:LH_BUILD_VERSION = $Version
$env:LH_RELEASE_NOTES_URL = "https://$VaultHost/releases/"
$env:NEXT_TELEMETRY_DISABLED = "1"
Run npm run build
Run node scripts/smoke-provider-runtime.mjs
Run node scripts/build-server.mjs
Run node scripts/smoke-server.mjs --electron

Write-Host "== package (NSIS installer, not code-signed, update feed https://$VaultHost/updates/)"
# The packaged app reads learnharnessBuild from its package.json (electron/main.cjs); extraMetadata
# sets it there without touching the checkout, as release-vault-build.sh does for Linux.
Run npx electron-builder --win nsis --x64 --publish never `
	"-c.extraMetadata.version=$Version" `
	"-c.extraMetadata.learnharnessBuild.vaultUrl=https://$VaultHost" `
	"-c.extraMetadata.learnharnessBuild.updateFeed=https://$VaultHost/updates/"

$unpacked = "dist\win-unpacked"
Run node scripts/smoke-provider-runtime.mjs --standalone "$unpacked\resources\server\standalone"
Run node scripts/smoke-provider-runtime.mjs --standalone "$unpacked\resources\server\standalone" --runtime "$unpacked\LearnHarness.exe"

# -- check what was packaged ---------------------------------------------------
$check = Join-Path ([System.IO.Path]::GetTempPath()) ("lh-vault-check-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $check | Out-Null
$asar = (Resolve-Path "$unpacked\resources\app.asar").Path
Push-Location $check
try { Run npx --yes "@electron/asar@3.4.1" extract-file $asar package.json } finally { Pop-Location }
$env:PACKAGED = Join-Path $check "package.json"
$env:VERSION = $Version
$env:VAULT_URL = "https://$VaultHost"
$env:UPDATE_FEED = "https://$VaultHost/updates/"
# The check runs from a file: Windows PowerShell 5.1 drops the double quotes of a native argument.
$checkScript = Join-Path $check "check.cjs"
Write-Utf8 $checkScript @'
const pkg = JSON.parse(require("node:fs").readFileSync(process.env.PACKAGED, "utf8"));
const b = pkg.learnharnessBuild ?? {};
if (pkg.version !== process.env.VERSION) throw new Error(`packaged version ${pkg.version}, expected ${process.env.VERSION}`);
if (b.vaultUrl !== process.env.VAULT_URL || b.updateFeed !== process.env.UPDATE_FEED || b.autoUpdate === false) throw new Error(`packaged learnharnessBuild ${JSON.stringify(b)}`);
console.log("packaged:", pkg.version, JSON.stringify(b));
'@
Run node $checkScript
Remove-Item -Recurse -Force $check

# -- result --------------------------------------------------------------------
$installer = "dist\LearnHarness-$Version-x64-setup.exe"
if (-not (Test-Path $installer)) { Fail "electron-builder did not write $installer" }
if (-not (Select-String -Path "dist\latest.yml" -Pattern "^version: $([regex]::Escape($Version))$" -Quiet)) { Fail "dist\latest.yml is missing or not version $Version" }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
Copy-Item $installer, "dist\latest.yml" -Destination $Out -Force
Write-Utf8 (Join-Path $Out "version.txt") "$Version`n"
Write-Host "== result in $Out"
Get-FileHash -Algorithm SHA256 (Join-Path $Out "LearnHarness-$Version-x64-setup.exe") | Format-List Hash, Path

if ($CopyTo) {
	Write-Host "== copying to $CopyTo"
	Run scp (Join-Path $Out "LearnHarness-$Version-x64-setup.exe") (Join-Path $Out "latest.yml") (Join-Path $Out "version.txt") $CopyTo
}
Write-Host "built vault Windows $Version"
