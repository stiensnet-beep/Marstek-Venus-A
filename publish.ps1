# Publiceer deze Homey-app naar jouw eigen GitHub-repository.
#
# Gebruik:
#   1) Maak op https://github.com/new een lege, PUBLIEKE repository aan
#      (naam bijvoorbeeld "Marstek-Venus-A"; laat README, .gitignore en
#      licentie uitgeschakeld - die zitten al in deze map).
#   2) Kopieer de URL die GitHub daarna toont en voer uit:
#
#        .\publish.ps1 https://github.com/stiensnet-beep/Marstek-Venus-A.git
#
# Dit script is al een keer gebruikt: de remote `origin` wijst naar
# https://github.com/stiensnet-beep/Marstek-Venus-A - een gewone `git push`
# volstaat dus voor volgende wijzigingen.
#
# Bij de eerste keer vraagt GitHub om in te loggen; er opent een browservenster
# (Git Credential Manager). Daarna kun je dit script bij elke wijziging opnieuw
# gebruiken om je repo bij te werken.
#
# Lukt het niet vanwege het uitvoeringsbeleid, gebruik dan:
#   powershell -ExecutionPolicy Bypass -File .\publish.ps1 <url>

param(
    [Parameter(Mandatory = $true)][string]$RepoUrl
)

$ErrorActionPreference = 'Stop'

# Git staat misschien nog niet in het PATH van dit venster
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    $env:PATH = "C:\Program Files\Git\cmd;$env:PATH"
}

if ($RepoUrl -notlike '*.git') {
    $RepoUrl = "$RepoUrl.git"
}

Write-Host "Repository: $RepoUrl"

if (git remote | Select-String -Quiet '^origin$') {
    git remote set-url origin $RepoUrl
} else {
    git remote add origin $RepoUrl
}

git push -u origin main

$web = $RepoUrl -replace '\.git$', ''

Write-Host ""
Write-Host "Klaar! Je repository staat op GitHub:"
Write-Host "  $web"
Write-Host ""
Write-Host "Plaats die link in je forumonderwerp - de tekst staat kant-en-klaar in FORUM_POST.md."
