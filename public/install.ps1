# huddle in one line, run inside your project folder (PowerShell):
#   & ([scriptblock]::Create((irm https://huddle.sage-hill.workers.dev/install.ps1))) INVITE    join a team
#   irm https://huddle.sage-hill.workers.dev/install.ps1 | iex                                   start a project
param([string]$Invite = '', [string]$Server = '')
$ErrorActionPreference = 'Stop'
function Fail($m) { Write-Host "huddle: $m" -ForegroundColor Red; exit 1 }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js isn't installed. Get it from https://nodejs.org (version 18 or newer), then run this again." }
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 18) { Fail "Node $(node -v) is too old. huddle needs version 18 or newer (22 is best): https://nodejs.org" }
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) { Fail 'npx is missing; it comes with Node.js from https://nodejs.org' }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Host "huddle: git isn't installed, so code won't be shared through huddle (live edits still are)." }
if (-not (Test-Path .git)) { Write-Host "huddle: this folder isn't a git repository. Run this from your project's root folder if you meant to." }

if ($Invite -and $Server) { npx -y github:flyingf15h/huddle join $Invite --server $Server }
elseif ($Invite) { npx -y github:flyingf15h/huddle join $Invite }
elseif ($env:HUDDLE_SERVER) { npx -y github:flyingf15h/huddle new --server $env:HUDDLE_SERVER }
else { npx -y github:flyingf15h/huddle new }
