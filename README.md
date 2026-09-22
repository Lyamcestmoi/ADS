# ADS Plateau de Diesse

Site officiel de l'ADS Plateau de Diesse, généré statiquement avec Astro et
hébergé sur GitHub Pages à l'adresse <https://ads-preles.ch>.

## Développement local

```bash
npm install
npm run dev
```

## Vérification et production

```bash
npm run check
npm run build
npm run preview
```

Le dossier `public/` contient les ressources servies telles quelles, notamment
le domaine personnalisé `CNAME` et la page de réservation historique. Cette
dernière sera migrée vers des composants Astro dans une prochaine étape.
