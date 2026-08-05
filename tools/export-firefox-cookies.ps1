$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$output = Join-Path $repoRoot "data\cookies.txt"
$profileSource = "C:\Users\Nemifist\AppData\Roaming\Mozilla\Firefox\Profiles\yja2tm34.default-release"
$profileTarget = Join-Path $repoRoot "data\firefox-profile"

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $output) | Out-Null
New-Item -ItemType Directory -Force -Path $profileTarget | Out-Null

if (Test-Path -LiteralPath $profileSource) {
  robocopy $profileSource $profileTarget cookies.sqlite key4.db cert9.db logins.json /R:1 /W:1 /NFL /NDL /NP | Out-Host
  if ($LASTEXITCODE -gt 7) {
    throw "Firefox profile copy failed with robocopy exit code $LASTEXITCODE"
  }
} else {
  throw "Firefox profile was not found: $profileSource"
}

$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) {
  throw "python was not found. It is needed to export cookies.sqlite to Netscape cookies.txt."
}

$exportScript = Join-Path $env:TEMP "ucontent_export_firefox_cookies.py"
Set-Content -Path $exportScript -Encoding ASCII -Value @'
import sqlite3
import sys

db_path, output_path = sys.argv[1], sys.argv[2]
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
rows = conn.execute(
    "select host, path, isSecure, isHttpOnly, expiry, name, value from moz_cookies"
).fetchall()

with open(output_path, "w", encoding="utf-8", newline="\n") as fh:
    fh.write("# Netscape HTTP Cookie File\n")
    for row in rows:
        host = str(row["host"] or "")
        if not host or not row["name"]:
            continue
        http_only = bool(row["isHttpOnly"])
        domain = "#HttpOnly_" + host if http_only else host
        include_subdomains = "TRUE" if host.startswith(".") else "FALSE"
        path = str(row["path"] or "/")
        secure = "TRUE" if row["isSecure"] else "FALSE"
        expiry = int(row["expiry"] or 0)
        name = str(row["name"])
        value = str(row["value"] or "")
        fh.write("\t".join([domain, include_subdomains, path, secure, str(expiry), name, value]) + "\n")
'@

& $python $exportScript (Join-Path $profileTarget "cookies.sqlite") $output
if ($LASTEXITCODE -ne 0) {
  throw "Cookie export failed with python exit code $LASTEXITCODE"
}

if (-not (Test-Path -LiteralPath $output)) {
  throw "Cookie export failed: $output was not created."
}

$item = Get-Item -LiteralPath $output
Write-Host "Exported cookies to $($item.FullName) ($($item.Length) bytes)"
Write-Host "Copied Firefox profile cookies to $profileTarget"
