#!/usr/bin/env bash
# Give aos-cloud Vertex AI (Gemini) through a service account that can only call Vertex on one project.
# Run from the PC with your own gcloud login:  bash ~/Developer/Ayush/agent-os/control/cloud/set-vertex-sa.sh [project]
# The key goes straight from gcloud over Tailscale into /etc/aos-cloud/vertex-sa.json (root:aoscloud 640);
# it is never written to this PC or shown on screen.
set -euo pipefail
# Settings come from control/.env.local (gitignored), or the environment.
conf() { sed -n "s/^$1=//p" "$(cd "$(dirname "$0")/.." && pwd)/.env.local" 2>/dev/null | tail -1 | sed "s/^[\"']//; s/[\"']\$//"; }
VM="${AOS_VM:-$(conf AOS_VM)}"; : "${VM:?set AOS_VM=ubuntu@<VM Tailscale IP> in control/.env.local}"
P="${1:-${VERTEX_PROJECT:-$(conf VERTEX_PROJECT)}}"; : "${P:?pass the GCP project id or set VERTEX_PROJECT in control/.env.local}"
SA="aos-cloud-vertex@$P.iam.gserviceaccount.com"

gcloud iam service-accounts describe "$SA" --project "$P" >/dev/null 2>&1 \
  || gcloud iam service-accounts create aos-cloud-vertex --project "$P" --display-name "aos-cloud (Vertex only)"
# A new service account takes a few seconds to become visible to IAM, so retry the role grant.
for i in 1 2 3 4 5 6 7 8; do
  gcloud projects add-iam-policy-binding "$P" --member "serviceAccount:$SA" --role roles/aiplatform.user \
    --condition None --quiet >/dev/null 2>&1 && break
  [[ $i == 8 ]] && { echo "could not grant Vertex AI User to $SA"; exit 1; }
  echo "waiting for the new service account to appear ($i/8)..."; sleep 10
done
echo "service account ready: $SA (role: Vertex AI User on $P)"

gcloud iam service-accounts keys create /dev/stdout --iam-account "$SA" --project "$P" 2>/dev/null \
  | ssh "$VM" "set -e
sudo sh -c 'umask 077; cat > /etc/aos-cloud/vertex-sa.json'
sudo test -s /etc/aos-cloud/vertex-sa.json
sudo chown root:aoscloud /etc/aos-cloud/vertex-sa.json && sudo chmod 640 /etc/aos-cloud/vertex-sa.json
sudo sed -i '/^VERTEX_PROJECT=/d;/^GOOGLE_APPLICATION_CREDENTIALS=/d' /etc/aos-cloud/env
printf 'VERTEX_PROJECT=%s\nGOOGLE_APPLICATION_CREDENTIALS=/etc/aos-cloud/vertex-sa.json\n' '$P' | sudo tee -a /etc/aos-cloud/env >/dev/null
sudo systemctl restart aos-cloud && sleep 6 && sudo journalctl -u aos-cloud -n 1 --no-pager -o cat"
echo "saved on the VM. Old keys of this account: gcloud iam service-accounts keys list --iam-account $SA"
