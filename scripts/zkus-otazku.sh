#!/bin/zsh
# Vyvolá v notchi zkušební Claudovu otázku (AskUserQuestion), bez Claude Code.
# Co klikneš, to skript vypíše jako odpověď, kterou by Claude Code dostal.
set -euo pipefail
key=~/Library/Application\ Support/cz.erikkarasek.dispecink/cc-hook-key
[[ -r $key ]] || { echo "Chybí klíč pro hooky, zapni je v nastavení Wispu."; exit 1; }
read -r k < $key
payload='{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","session_id":"zkouska",
 "cwd":"'$HOME'/Developer/dispecink","tool_input":{"questions":[
  {"question":"Kterou cestou to postavit?","header":"Přístup","multiSelect":false,"options":[
    {"label":"Rychle","description":"Hotovo dneska, míň odladěné"},
    {"label":"Pořádně","description":"Dva dny, ale drží to"}]},
  {"question":"Co k tomu přidat?","header":"Navíc","multiSelect":true,"options":[
    {"label":"Testy","description":"Pokrýt to testy"},
    {"label":"Dokumentace","description":"Dopsat README"},
    {"label":"Nic","description":"Jen ten kód"}]}]}}'
echo "Otázka je v notchi, máš na ni 150 s. Odpověz na ni tlačítky."
out=$(curl -s -m 160 -H 'content-type: application/json' -d "$payload" "http://127.0.0.1:47811/cc/ask?k=$k")
if [[ -z $out ]]; then
  echo "Nic se nevrátilo: buď Terminál, nebo vypršel čas. Claude Code by se zeptal v terminálu."
else
  echo "Claude Code by dostal:"
  echo "$out" | python3 -m json.tool
fi
