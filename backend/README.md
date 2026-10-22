# Réservations ADS : mise en service

Le site Astro reste sur GitHub Pages. Le service `worker.ts` est destiné à un
Cloudflare Worker avec une base D1 privée. Ce patch ne crée aucun compte,
ne déploie pas le service et ne connecte aucune banque.

## Ce qui fonctionne sans ce service

- Choix TWINT ou e-banking, repris dans le PDF et l’e-mail préparé.
- Retrait de l’ancien autocollant QR TWINT.
- Jours fériés bernois calculés pour chaque année, y compris les fêtes mobiles.
- Tarifs de fin de semaine dès le vendredi, conformément à la grille publiée.
- Demande de réservation par PDF et e-mail à la gérance, comme précédemment.
- Le formulaire précise qu’il n’a pas encore bloqué la date.

La réduction membre n’est plus activable avec une case déclarative. En attendant
la liste privée, la gérance vérifie le statut et établit le tarif membre.

## Ce qui fonctionne après activation du service

- Une option est créée seulement après réception côté serveur du contrat signé
  et vérification de la disponibilité. Le serveur recalcule le tarif.
- Tous les jours d’une location sont bloqués dans une seule transaction SQL.
  Deux demandes concurrentes ne peuvent pas s’attribuer le même jour.
- Une option non payée expire après 168 heures, ou au début de la location si
  celui-ci est plus proche. Les demandes pour le jour même passent par la gérance.
- Les options expirées ne bloquent plus le calendrier, même si la tâche planifiée
  n’a pas encore nettoyé la base.
- L’agenda du site montre séparément les dates libres, en option et confirmées.
  Les réservations déjà présentes dans l’agenda Google restent prises en compte.
- `/gestion/` permet à la gérance authentifiée de gérer sa liste de membres et
  d’enregistrer les paiements réellement reçus.
- Un membre utilise son nom, son e-mail et un code personnel généré par la gérance.
  La réduction et l’absence de caution sont revérifiées lors de l’enregistrement.
  La liste privée et les codes ne sont jamais inclus dans le site public.

Les options du nouveau service ne sont pas écrites dans Google Calendar : elles
apparaissent dans l’agenda du site et dans `/gestion/`. Il faudra un accès Google
Calendar autorisé pour ajouter cette synchronisation sortante. Éviter de gérer
deux réservations concurrentes dans les deux outils : une écriture Google
extérieure ne peut pas être rendue atomique avec la transaction D1.

Le parseur Google existant n’étend pas les règles récurrentes. Le service refuse
donc les nouvelles options si le flux contient `RRULE` ou `RDATE`, au lieu de
présenter des occurrences comme libres. Étendre ce parseur avant activation si
l’agenda contient ce type d’événements.

## Déploiement (PowerShell, depuis la racine du dépôt)

Le compte Cloudflare et la base doivent appartenir à l’association ou à son
responsable. Le compte bancaire, l’IBAN et le lien de paiement doivent être
validés par la gérance avant une utilisation réelle.

```powershell
Copy-Item .\backend\wrangler.example.jsonc .\backend\wrangler.jsonc
npx wrangler login
npx wrangler d1 create ads-reservations
```

Reporter le `database_id` retourné dans `backend/wrangler.jsonc`. Ne pas utiliser
un identifiant de base existante non liée à ce projet. Ensuite :

```powershell
npx wrangler d1 migrations apply ads-reservations --remote --config .\backend\wrangler.jsonc
npx wrangler secret put ADMIN_TOKEN --config .\backend\wrangler.jsonc
npx wrangler secret put MEMBER_SECRET --config .\backend\wrangler.jsonc
npx wrangler deploy --config .\backend\wrangler.jsonc
```

Utiliser deux secrets indépendants générés aléatoirement, d’au moins 32 caractères.
Ils sont saisis dans les invites Wrangler, jamais dans GitHub, le fichier `.env`
public ou le code du navigateur. La clé d’administration donne accès aux données
des locataires : ne la remettre qu’aux personnes responsables de la gérance.

Facultatif : ajouter la variable serveur `TWINT_PAYMENT_URL`, avec un vrai lien
de paiement en ligne émis pour l’ADS, pour proposer un bouton après l’option.
Sans ce lien, le formulaire indique que la gérance transmet les consignes TWINT.
L’IBAN affiché est celui du contrat communal du 19.04.2025, à revalider avec l’ADS.

Pour connecter le site : créer dans le dépôt GitHub une **variable Actions**
`PUBLIC_BOOKING_API_URL` contenant l’URL HTTPS du Worker, sans slash final, puis
relancer le workflow de déploiement. Pour le développement local, copier
`.env.example` vers `.env` et renseigner cette même URL. Seule cette adresse est
publique : elle ne contient aucune clé.

Avant d’accepter des clients réels, tester le parcours sur le compte de
l’association : accès privé, ajout et désactivation d’un membre, option,
conflit de dates, paiement, expiration et calendrier. Les tests SQLite locaux
ne remplacent pas un essai de la configuration Cloudflare réelle.

## Gérance et paiements

Sur `/gestion/`, entrer la clé d’administration, ajouter les membres avec leur
nom complet et leur e-mail, puis transmettre individuellement le code affiché.
Un code est affiché uniquement à sa génération ; la base conserve son empreinte.
Réinitialiser un code invalide l’ancien. Ne pas placer une liste de membres dans
`public/`, `src/`, les variables `PUBLIC_*` ou le dépôt GitHub.

Après avoir constaté un paiement réel sur le compte ou dans TWINT, saisir dans la
réservation le montant reçu et la référence de transaction. Seule une option
encore active, avec le montant intégral attendu, peut être confirmée. Un paiement
tardif nécessite une vérification de disponibilité et un traitement par la gérance.
Le paiement n’est jamais déduit d’un clic du client ou d’une capture d’écran.

**Ce patch ne détecte pas automatiquement les entrées bancaires ou TWINT.**
Il faut pour cela une intégration avec la banque (ou un flux de rapprochement
autorisé), ou une solution de paiement en ligne fournissant une notification
authentifiée. Aucun prestataire payant n’est activé par ce patch. Les e-mails et
le PDF continuent d’être enregistrés/envoyés par le client ; l’envoi automatique
côté serveur est une étape distincte.

## Sources et donateurs

- Contrat publié par la commune :
  https://www.leplateaudediesse.ch/locations-de-salles/Stand-ADS-Preles
  (option à réception du contrat signé, paiement sous sept jours, caution et
  réduction de 20 % pour les membres).
- Jours fériés : liste officielle du canton de Berne, RSB 555.1 ; les demi-journées
  chômées des agents cantonaux des 24 et 31 décembre ne sont pas des jours fériés
  généraux et ne déclenchent pas de supplément.
  https://www.taxinfo.sv.fin.be.ch/taxinfo/2d6dc2c5-f917-4460-abcd-3444ec80266e?lang=fr
- Aucune règle tarifaire pour les donateurs ADS trouvée sur la page communale ni
  dans le contrat publié. Le site propose donc de contacter la gérance, sans
  inventer une réduction ou une exemption de caution.

## Vérifications locales (Node 24)

```powershell
node --test tests/reservations.test.mjs
npm run build
```
