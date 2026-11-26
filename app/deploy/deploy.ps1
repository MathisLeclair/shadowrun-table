<#
.SYNOPSIS
  Deploy the Shadowrun table to the OVH VPS (docker compose project "shadowrun", plain HTTP on port 8095).
  Run from the owner's Windows PC. Never touches the other stack of the VPS (ports 80/443).

.DESCRIPTION
  -Action setup     First install: deploy key for the private GitHub repo, clone into ~/shadowrun, .env with the
                    admin password, data folders, ufw rule for 8095/tcp, docker compose up -d --build.
  -Action update    (default) Snapshot the data, git pull, rebuild and restart, wait until healthy.
  -Action assets    Copy app/data/assets/foundry (~490 MB, Foundry images/music of Project Lazarus) to the VPS.
  -Action music     Copy app/data/assets/music (~330 MB, shared music library: Karl Casey, Dan Cramp) to the VPS.
  -Action migrate   Send the local Project Lazarus table (state, uploads, campaign docs) to the VPS.
  -Action ai-setup  GM assistant: write the Claude Workload Identity Federation ids (org, rule…) to .env, restart.
  -Action backup    Download a .tar.gz of every table from the VPS into -BackupDir (assistant signing key left out).
  -Action rollback  Go back to the image (and commit) that ran before the last update.
  -Action status    Container state, health, disk usage.   -Action logs   Last 200 log lines.
  See DEPLOY.md for the whole procedure.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\deploy\deploy.ps1 -Action setup
  powershell -ExecutionPolicy Bypass -File .\deploy\deploy.ps1
#>
[CmdletBinding()]
param(
  [ValidateSet('setup', 'update', 'assets', 'music', 'migrate', 'ai-setup', 'backup', 'rollback', 'status', 'logs')]
  [string]$Action = 'update',
  [string]$VpsHost = '152.228.134.90',
  [string]$VpsUser = 'ubuntu',
  [string]$KeyFile = (Join-Path $HOME '.ssh\gachabackend_deploy'),
  [string]$RepoPath = 'MathisLeclair/shadowrun-table',
  [string]$Branch = 'main',
  [string]$BackupDir = (Join-Path $HOME 'Documents\shadowrun-vps-backups'),
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$Ssh = 'C:\Windows\System32\OpenSSH\ssh.exe'
$Scp = 'C:\Windows\System32\OpenSSH\scp.exe'
$Tar = 'C:\Windows\System32\tar.exe'
$AppDir = Split-Path -Parent $PSScriptRoot      # ...\shadowrun\app
$RepoRoot = Split-Path -Parent $AppDir          # ...\shadowrun
$Target = "$VpsUser@$VpsHost"
$SshOpts = @('-i', $KeyFile, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', 'BatchMode=yes')

function Write-Step([string]$Text) { Write-Host "`n==> $Text" -ForegroundColor Cyan }
function Confirm-Step([string]$Question) {
  if ($Yes) { return $true }
  $a = Read-Host "$Question [o/N]"
  return $a -match '^(o|oui|y|yes)$'
}

foreach ($exe in @($Ssh, $Scp, $Tar)) {
  if (-not (Test-Path $exe)) { throw "Introuvable : $exe (installe le client OpenSSH de Windows)" }
}
if (-not (Test-Path $KeyFile)) { throw "Cle SSH introuvable : $KeyFile" }

# Common bash prelude run before every remote script (ASCII only).
$Prelude = @'
set -euo pipefail
R="$HOME/shadowrun"
APP="$R/app"
BK="$HOME/shadowrun-backups"
mkdir -p "$BK"
dc() { (cd "$APP" && docker compose "$@"); }
wait_healthy() {
  for i in $(seq 1 60); do
    s=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' shadowrun 2>/dev/null || echo missing)
    if [ "$s" = "healthy" ]; then echo "Container healthy."; return 0; fi
    sleep 3
  done
  echo "Container NOT healthy (state: $s). Last logs:" >&2
  dc logs --tail 60 >&2 || true
  return 1
}
fix_owner() {
  # The container runs as uid 1000 (user "node"): data folders must belong to it.
  if [ "$(stat -c %u "$1")" != "1000" ]; then sudo chown -R 1000:1000 "$1"; fi
}
snapshot() {
  # Data snapshot before risky operations (uploaded Foundry worlds and temp files excluded: re-uploadable / transient).
  if [ -d "$APP/runtime" ]; then
    f="$BK/runtime-$(date +%Y%m%d-%H%M%S)-$1.tar.gz"
    tar -czf "$f" -C "$APP" --exclude='runtime/tables/*/foundry' --exclude='runtime/tmp' runtime
    echo "Snapshot: $f ($(du -h "$f" | cut -f1))"
    ls -1t "$BK"/runtime-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
  fi
}
'@

function Invoke-Remote([string]$Script, [hashtable]$Vars = @{}, [switch]$AllowFail) {
  $body = $Script
  foreach ($k in $Vars.Keys) { $body = $body.Replace("__${k}__", [string]$Vars[$k]) }
  $full = ($Prelude + "`n" + $body) -replace "`r", ''
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($full))
  # Remote output is shown as it comes (Write-Host), never returned: callers get nothing on the pipeline.
  & $Ssh @SshOpts $Target "echo $b64 | base64 -d | bash" | ForEach-Object { Write-Host $_ }
  $code = $LASTEXITCODE
  if ($code -ne 0 -and -not $AllowFail) { throw "La commande distante a echoue (code $code)" }
}

function Test-Remote([string]$Command) {
  $out = (& $Ssh @SshOpts $Target "$Command && echo __YES__ || echo __NO__") -join "`n"
  if ($LASTEXITCODE -ne 0) { throw "Connexion SSH impossible a $Target" }
  return $out -match '__YES__'
}

function Send-File([string]$Local, [string]$Remote) {
  & $Scp @SshOpts $Local "${Target}:$Remote"
  if ($LASTEXITCODE -ne 0) { throw "Copie scp echouee : $Local" }
}

function Read-AdminPassword {
  while ($true) {
    $p1 = Read-Host 'Mot de passe ADMINISTRATEUR de la table (12 caracteres min., ASCII)' -AsSecureString
    $p2 = Read-Host 'Confirme le mot de passe' -AsSecureString
    $a = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p1))
    $b = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p2))
    if ($a -ne $b) { Write-Warning 'Les deux saisies different.'; continue }
    if ($a.Length -lt 12) { Write-Warning 'Trop court (12 caracteres minimum).'; continue }
    if ($a -notmatch '^[\x21-\x7E]+$' -or $a -match "['`"\\$]") { Write-Warning 'Utilise des caracteres ASCII visibles, sans espace, guillemet, $ ni antislash.'; continue }
    return $a
  }
}

# ---------------------------------------------------------------------------
switch ($Action) {
  'setup' {
    Write-Step "Verification du VPS ($Target)"
    Invoke-Remote @'
command -v docker >/dev/null || { echo "Docker is not installed." >&2; exit 1; }
docker compose version >/dev/null || { echo "docker compose (v2 plugin) is missing." >&2; exit 1; }
command -v git >/dev/null || sudo apt-get install -y git
if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE '(^|:)8095$'; then
  if ! docker ps --format '{{.Names}}' | grep -qx shadowrun; then echo "Port 8095 is already used by something else on the VPS." >&2; exit 1; fi
fi
echo "Docker: $(docker --version)"; echo "Compose: $(docker compose version --short)"
'@

    Write-Step 'Cle de deploiement GitHub (lecture seule) sur le VPS'
    Invoke-Remote @'
KEY="$HOME/.ssh/shadowrun_deploy"
mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
if [ ! -f "$KEY" ]; then ssh-keygen -t ed25519 -N "" -C "shadowrun-vps-deploy" -f "$KEY" >/dev/null; fi
if ! grep -q "Host github-shadowrun" "$HOME/.ssh/config" 2>/dev/null; then
  printf '\nHost github-shadowrun\n  HostName github.com\n  User git\n  IdentityFile %s\n  IdentitiesOnly yes\n' "$KEY" >> "$HOME/.ssh/config"
  chmod 600 "$HOME/.ssh/config"
fi
ssh-keyscan -t ed25519 github.com 2>/dev/null >> "$HOME/.ssh/known_hosts"; sort -u -o "$HOME/.ssh/known_hosts" "$HOME/.ssh/known_hosts"
if [ -d "$R/.git" ]; then echo "ALREADY_CLONED"; else echo "PUBKEY: $(cat "$KEY.pub")"; fi
'@

    $cloned = Test-Remote 'test -d ~/shadowrun/.git'
    if (-not $cloned) {
      Write-Host "`nAjoute la cle publique ci-dessus dans GitHub :" -ForegroundColor Yellow
      Write-Host "  https://github.com/$RepoPath/settings/keys  ->  Add deploy key  (titre: VPS OVH, NE PAS cocher 'Allow write access')"
      Read-Host 'Appuie sur Entree une fois la cle ajoutee'
      Write-Step 'Clonage du depot dans ~/shadowrun'
      Invoke-Remote @'
git clone --branch "__BRANCH__" "git@github-shadowrun:__REPO__.git" "$R"
'@ -Vars @{ BRANCH = $Branch; REPO = $RepoPath }
    } else {
      Write-Host 'Depot deja clone.'
    }

    if (-not (Test-Remote 'test -f ~/shadowrun/app/.env')) {
      Write-Step 'Fichier .env (mot de passe administrateur)'
      $pw = Read-AdminPassword
      # Sent through stdin (never on a command line); \r stripped on the VPS.
      "SR_ADMIN_PASSWORD=$pw" | & $Ssh @SshOpts $Target "umask 077; tr -d '\r' > ~/shadowrun/app/.env"
      if ($LASTEXITCODE -ne 0) { throw 'Ecriture du .env impossible' }
      $pw = $null
    } else {
      Write-Host '.env deja present (mot de passe admin inchange).'
    }

    Write-Step 'Dossiers de donnees, pare-feu, premier demarrage'
    Invoke-Remote @'
mkdir -p "$APP/runtime" "$APP/data/assets/foundry" "$APP/data/assets/music"
fix_owner "$APP/runtime"; fix_owner "$APP/data/assets/foundry"; fix_owner "$APP/data/assets/music"
if command -v ufw >/dev/null && sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow 8095/tcp comment 'shadowrun table' >/dev/null && echo "ufw: 8095/tcp allowed"
else
  echo "ufw inactive: nothing to open (check the OVH network firewall if one is configured)"
fi
dc up -d --build
wait_healthy
'@
    Write-Host "`nPret : http://${VpsHost}:8095/   (administration : http://${VpsHost}:8095/admin)" -ForegroundColor Green
    Write-Host 'Etapes suivantes : -Action assets (images/musiques Foundry), puis -Action migrate (ta partie Project Lazarus).'
  }

  'update' {
    Push-Location $RepoRoot
    try {
      $st = (git status -sb 2>$null | Select-Object -First 1)
      if ($st -match 'ahead') {
        Write-Warning "Des commits locaux ne sont pas pousses sur GitHub ($st) : le VPS ne les verra pas."
        if (-not (Confirm-Step 'Continuer quand meme ?')) { return }
      }
    } finally { Pop-Location }
    Write-Step "Mise a jour sur $VpsHost (branche $Branch)"
    Invoke-Remote @'
snapshot before-update
git -C "$R" rev-parse HEAD > "$BK/previous-commit"
docker image inspect shadowrun-app:latest >/dev/null 2>&1 && docker tag shadowrun-app:latest shadowrun-app:previous
git -C "$R" fetch --prune origin
git -C "$R" checkout "__BRANCH__"
git -C "$R" pull --ff-only origin "__BRANCH__"
echo "Now at: $(git -C "$R" log -1 --format='%h %s')"
dc up -d --build
wait_healthy
docker image prune -f --filter label=app=shadowrun-table >/dev/null
'@ -Vars @{ BRANCH = $Branch }
    Write-Host "`nA jour : http://${VpsHost}:8095/" -ForegroundColor Green
  }

  { $_ -in 'assets', 'music' } {
    # assets = Foundry images/music of Project Lazarus; music = shared music library (every table).
    $folder = if ($Action -eq 'music') { 'music' } else { 'foundry' }
    $src = Join-Path $AppDir "data\assets\$folder"
    if (-not (Test-Path $src)) { throw "Rien a envoyer : $src n'existe pas" }
    $size = (Get-ChildItem $src -Recurse -File | Measure-Object Length -Sum).Sum
    Write-Step ("Envoi de data/assets/$folder ({0:N0} Mo)" -f ($size / 1MB))
    $tmp = Join-Path $env:TEMP "sr-$folder-assets.tar"
    if (Test-Path $tmp) { Remove-Item $tmp -Force }
    & $Tar -cf $tmp -C (Join-Path $AppDir 'data\assets') $folder
    if ($LASTEXITCODE -ne 0) { throw 'Archive tar impossible' }
    try {
      Send-File $tmp "sr-$folder-assets.tar"
      Invoke-Remote @'
mkdir -p "$APP/data/assets"
tar -xf "$HOME/sr-__FOLDER__-assets.tar" -C "$APP/data/assets"
rm -f "$HOME/sr-__FOLDER__-assets.tar"
fix_owner "$APP/data/assets/__FOLDER__"
echo "data/assets/__FOLDER__: $(du -sh "$APP/data/assets/__FOLDER__" | cut -f1)"
'@ -Vars @{ FOLDER = $folder }
    } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
    Write-Host "Fichiers en place (servis sous /assets/$folder, pas besoin de redemarrer)." -ForegroundColor Green
  }

  'migrate' {
    $tableDir = Join-Path $AppDir 'data\tables\lazarus'
    $legacyState = Join-Path $AppDir 'data\state.json'
    if (Test-Path (Join-Path $tableDir 'state.json')) { $mode = 'table' }
    elseif (Test-Path $legacyState) { $mode = 'legacy' }
    else { throw 'Aucune partie locale trouvee (ni data\tables\lazarus\state.json ni data\state.json).' }
    if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) {
      Write-Warning 'Le serveur local semble tourner (port 3000) : ferme-le d''abord pour que la derniere version de la partie soit sur le disque.'
      if (-not (Confirm-Step 'Continuer quand meme ?')) { return }
    }
    if ((Test-Remote 'test -f ~/shadowrun/app/runtime/tables/lazarus/state.json') -and -not (Confirm-Step 'Une table "lazarus" existe deja sur le VPS : la remplacer (elle sera sauvegardee avant) ?')) { return }

    Write-Step "Preparation de la table Project Lazarus (source : $mode)"
    $stage = Join-Path $env:TEMP 'sr-migrate'
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    $dst = Join-Path $stage 'lazarus'
    New-Item -ItemType Directory -Force (Join-Path $dst 'docs') | Out-Null
    if ($mode -eq 'table') {
      Copy-Item (Join-Path $tableDir 'state.json') $dst
      if (Test-Path (Join-Path $tableDir 'uploads')) { Copy-Item (Join-Path $tableDir 'uploads') $dst -Recurse }
      if (Test-Path (Join-Path $tableDir 'table.json')) { Copy-Item (Join-Path $tableDir 'table.json') $dst }
    } else {
      Copy-Item $legacyState (Join-Path $dst 'state.json')
      if (Test-Path (Join-Path $AppDir 'data\uploads')) { Copy-Item (Join-Path $AppDir 'data\uploads') $dst -Recurse }
    }
    if (-not (Test-Path (Join-Path $dst 'table.json'))) {
      '{"id":"lazarus","slug":"lazarus","name":"Project Lazarus","pack":"project-lazarus","lang":"fr","legacy":true,"docsDir":"../Shadowrun"}' |
        Set-Content -Encoding ascii (Join-Path $dst 'table.json')
    }
    # Campaign docs (../Shadowrun/*.md and one folder level, e.g. foundry/) go into the table's own docs folder.
    $docs = Join-Path $RepoRoot 'Shadowrun'
    if (Test-Path $docs) {
      Get-ChildItem $docs -Filter *.md -File | Copy-Item -Destination (Join-Path $dst 'docs')
      Get-ChildItem $docs -Directory | Where-Object { $_.Name -notlike '.*' } | ForEach-Object {
        $sub = Join-Path (Join-Path $dst 'docs') $_.Name
        $mds = Get-ChildItem $_.FullName -Filter *.md -File
        if ($mds) { New-Item -ItemType Directory -Force $sub | Out-Null; $mds | Copy-Item -Destination $sub }
      }
    }
    $tarFile = Join-Path $env:TEMP 'sr-lazarus.tar'
    if (Test-Path $tarFile) { Remove-Item $tarFile -Force }
    & $Tar -cf $tarFile -C $stage lazarus
    if ($LASTEXITCODE -ne 0) { throw 'Archive tar impossible' }
    try {
      Write-Step 'Envoi et installation sur le VPS (le conteneur est arrete pendant l''operation)'
      Send-File $tarFile 'sr-lazarus.tar'
      Invoke-Remote @'
snapshot before-migrate
mkdir -p "$APP/runtime/tables"
dc stop shadowrun || true
if [ -d "$APP/runtime/tables/lazarus" ]; then
  mv "$APP/runtime/tables/lazarus" "$BK/lazarus-replaced-$(date +%Y%m%d-%H%M%S)"
fi
tar -xf "$HOME/sr-lazarus.tar" -C "$APP/runtime/tables"
rm -f "$HOME/sr-lazarus.tar"
fix_owner "$APP/runtime"
dc up -d
wait_healthy
'@
    } finally {
      Remove-Item $tarFile -Force -ErrorAction SilentlyContinue
      Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host "`nProject Lazarus est en ligne : http://${VpsHost}:8095/t/lazarus/  (meme mot de passe MJ qu'en local)" -ForegroundColor Green
  }

  'ai-setup' {
    # GM assistant: Workload Identity Federation ids (not secrets) written to ~/shadowrun/app/.env, container recreated.
    Write-Host 'Identifiants de la Console Claude (Workload identity). Aucun secret : la cle privee reste sur le VPS.' -ForegroundColor Yellow
    $org = (Read-Host 'ID de l''organisation (UUID)').Trim()
    $rule = (Read-Host 'ID de la regle de federation (fdrl_...)').Trim()
    $ws = (Read-Host 'ID de l''espace de travail (wrkspc_..., Entree si la regle ne couvre qu''un espace)').Trim()
    $sa = (Read-Host 'ID du compte de service (svac_..., Entree pour laisser la regle choisir)').Trim()
    foreach ($v in @($org, $rule, $ws, $sa)) {
      if ($v -and $v -notmatch '^[A-Za-z0-9_-]{4,100}$') { throw "Identifiant invalide : $v" }
    }
    if (-not $org -or -not $rule) { throw 'L''organisation et la regle sont obligatoires.' }
    Invoke-Remote @'
ENV="$APP/.env"
touch "$ENV"; chmod 600 "$ENV"
# Replace previous assistant settings; an API key would outrank federation, so it never stays in .env.
grep -vE '^(ANTHROPIC_ORGANIZATION_ID|ANTHROPIC_FEDERATION_RULE_ID|ANTHROPIC_WORKSPACE_ID|ANTHROPIC_SERVICE_ACCOUNT_ID|ANTHROPIC_API_KEY)=' "$ENV" > "$ENV.tmp" || true
{
  echo "ANTHROPIC_ORGANIZATION_ID=__ORG__"
  echo "ANTHROPIC_FEDERATION_RULE_ID=__RULE__"
  [ -n "__WS__" ] && echo "ANTHROPIC_WORKSPACE_ID=__WS__"
  [ -n "__SA__" ] && echo "ANTHROPIC_SERVICE_ACCOUNT_ID=__SA__"
  true
} >> "$ENV.tmp"
mv "$ENV.tmp" "$ENV"; chmod 600 "$ENV"
dc up -d --no-build
wait_healthy
echo "Assistant settings applied. Check /admin -> Assistant IA -> Tester la connexion."
'@ -Vars @{ ORG = $org; RULE = $rule; WS = $ws; SA = $sa }
    Write-Host "`nOuvre http://${VpsHost}:8095/admin -> Assistant IA -> « Tester la connexion », puis active la table." -ForegroundColor Green
  }

  'backup' {
    New-Item -ItemType Directory -Force $BackupDir | Out-Null
    Write-Step 'Sauvegarde des tables sur le VPS'
    $name = 'shadowrun-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.tar.gz'
    Invoke-Remote @'
tar -czf "$HOME/__NAME__" -C "$APP" --exclude='runtime/tables/*/foundry' --exclude='runtime/tmp' --exclude='runtime/assistant/signing-key.pem' runtime
echo "Archive: $(du -h "$HOME/__NAME__" | cut -f1)"
'@ -Vars @{ NAME = $name }
    & $Scp @SshOpts "${Target}:$name" (Join-Path $BackupDir $name)
    $ok = $LASTEXITCODE -eq 0
    & $Ssh @SshOpts $Target "rm -f ~/$name" | Out-Null
    if (-not $ok) { throw 'Telechargement de la sauvegarde echoue' }
    Write-Host "Sauvegarde : $(Join-Path $BackupDir $name)" -ForegroundColor Green
  }

  'rollback' {
    if (-not (Confirm-Step 'Revenir a la version precedente de l''application (les donnees ne changent pas) ?')) { return }
    Invoke-Remote @'
docker image inspect shadowrun-app:previous >/dev/null 2>&1 || { echo "No previous image: nothing to roll back to." >&2; exit 1; }
docker tag shadowrun-app:previous shadowrun-app:latest
if [ -f "$BK/previous-commit" ]; then git -C "$R" checkout --detach "$(cat "$BK/previous-commit")"; fi
dc up -d --no-build
wait_healthy
echo "Rolled back to $(git -C "$R" log -1 --format='%h %s'). The next update returns to the branch head."
'@
  }

  'status' {
    Invoke-Remote @'
dc ps
echo; echo "Health: $(curl -fsS -m 5 http://127.0.0.1:8095/api/health || echo unreachable)"
echo; echo "Code: $(git -C "$R" log -1 --format='%h %s (%cr)')"
echo; du -sh "$APP/runtime" "$APP/data/assets/foundry" "$APP/data/assets/music" 2>/dev/null || true
df -h "$APP" | tail -1
echo; ls -1t "$BK" 2>/dev/null | head -5
'@ -AllowFail
  }

  'logs' {
    Invoke-Remote 'dc logs --tail 200' -AllowFail
  }
}
