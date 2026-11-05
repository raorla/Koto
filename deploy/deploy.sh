#!/usr/bin/env bash
# Installe ou met à jour Koto sur le serveur, depuis ce PC : copie le code, installe les dépendances,
# compile, puis (re)démarre le service systemd. Ne touche jamais au .env ni au dossier data/ du serveur.
#
# Usage : deploy/deploy.sh ubuntu@IP_DU_SERVEUR
# Le compte SSH doit pouvoir utiliser sudo sans mot de passe (c'est le cas du compte « ubuntu » chez Oracle).
set -euo pipefail

cible="${1:?Usage : deploy/deploy.sh utilisateur@serveur}"
cd "$(dirname "$0")/.."

# Deux Koto avec le même token se disputent les messages (erreur 409 de Telegram).
if pgrep -f 'tsx.*src/index\.ts|node.*dist/index\.js' >/dev/null && [ "${KOTO_LOCAL_OK:-}" != 1 ]; then
  echo "❌ Un Koto tourne encore sur ce PC : arrête-le (Ctrl+C dans son terminal), puis relance."
  echo "   S'il utilise un autre bot que celui du serveur, relance avec KOTO_LOCAL_OK=1."
  exit 1
fi

echo "→ Copie du code vers $cible"
rsync -az --delete --mkpath \
  --exclude '/node_modules' --exclude '/dist' --exclude '/data' --include '/.env.example' --exclude '/.env*' \
  --rsync-path='sudo -u koto rsync' \
  ./ "$cible:/home/koto/koto/"

echo "→ Installation, compilation et redémarrage sur le serveur"
ssh "$cible" 'bash -s' <<'SERVEUR'
set -euo pipefail
# </dev/null : aucune commande ne doit lire la suite de ce script, qui arrive par l'entrée standard.
sudo -u koto -H bash -lc '
  set -euo pipefail
  cd ~/koto
  if [ ! -f .env ]; then
    echo "❌ Pas de .env sur le serveur : envoie-le d’abord (README, « Déployer 24/7 »)."
    exit 1
  fi
  npm ci --no-audit --no-fund
  npm run build
  npx playwright install --only-shell chromium
' </dev/null
# Bibliothèques système de Chromium (rapide si elles sont déjà là).
if ! sudo /home/koto/koto/node_modules/.bin/playwright install-deps chromium </dev/null >/tmp/koto-deps.log 2>&1; then
  echo "⚠️  Dépendances de Chromium non installées (apt occupé ?) : les tâches web peuvent échouer. Détail : /tmp/koto-deps.log"
fi
sudo install -m 644 /home/koto/koto/deploy/koto.service /etc/systemd/system/koto.service
sudo systemctl daemon-reload
sudo systemctl enable --quiet koto
debut=$(date '+%Y-%m-%d %H:%M:%S')
sudo systemctl restart koto
# On attend la ligne « Koto est en ligne » (src/index.ts), au plus une minute.
for _ in $(seq 30); do
  sleep 2
  if sudo journalctl -u koto --since "$debut" -o cat | grep -q 'Koto est en ligne'; then
    echo "✅ Koto est en ligne sur le serveur."
    sudo journalctl -u koto --since "$debut" -n 5 --no-pager -o cat
    exit 0
  fi
done
echo "❌ Koto n'a pas démarré en une minute. Derniers logs :"
sudo journalctl -u koto --since "$debut" -n 30 --no-pager -o cat
exit 1
SERVEUR
echo "Logs en direct : ssh -t $cible sudo journalctl -u koto -f"
