# ADS — développement local

## Site public en construction

GitHub Pages publie uniquement le contenu du dossier `maintenance/`.
Ce dossier contient la page de chantier en français, allemand et anglais,
ses coordonnées de contact et une page de remplacement pour les anciennes URL.

Le workflow `.github/workflows/deploy.yml` se déclenche sur `main` ou manuellement.
Il charge exclusivement `maintenance/`. Le site Astro complet reste dans
`src/` et `public/` pour le développement local.
La publication horaire de la version complète est arrêtée.

## Travailler sur le site complet

Depuis PowerShell :

```powershell
cd C:\Temp\ads\ADS
git fetch origin
git switch develop
npm ci
npm run dev
```

`git switch develop` sélectionne la branche locale existante ou crée son suivi
de `origin/develop` après le premier `git fetch`.
Ouvrir ensuite l’adresse locale affichée par Astro dans le terminal.
Les modifications sont visibles dans le navigateur pendant que le serveur tourne.
Arrêter le serveur avec `Ctrl+C`.

Le développement du front peut se faire avec `PUBLIC_BOOKING_API_URL` vide
dans le fichier local `.env`, pour conserver le parcours PDF/e-mail.
Les secrets et les fichiers `.env` restent hors du dépôt.

## Vérifier et sauvegarder

```powershell
npm run build
git push origin develop
```

La branche `develop` sert à sauvegarder le travail en cours.
Les visiteurs du domaine public voient la page de chantier.

## Remise en ligne du site complet

La remise en ligne nécessitera un changement explicite du workflow de déploiement
après validation du site. Le contenu et les données du projet sont conservés.
