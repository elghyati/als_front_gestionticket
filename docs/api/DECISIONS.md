# Contrat API MVP : décisions, questions ouvertes, risques

Story 3.2 : API simulée et contrat OpenAPI. Responsable : Si Abdelkbir.
Statut : **BROUILLON** (version 0.3.0), gel prévu le **lundi 12 octobre**.

## Appels couverts (50 opérations)

| Domaine | Appels | Utilisé par |
|---|---|---|
| Authentification | `POST /auth/login` | Kiosque, portail |
| Comptes | `GET /accounts/{id}/balance`, `GET /accounts/{id}/transactions` | Kiosque |
| Opérations | `POST /deposits`, `POST /withdrawals` | Kiosque |
| Kiosques | `GET, POST /kms/kiosks` ; `GET, PATCH, DELETE /kms/kiosks/{id}` | Portail |
| Services d'un kiosque | `GET /kms/kiosks/{id}/services` ; `PUT, DELETE /kms/kiosks/{id}/services/{code}` | Kiosque (menu), mode dégradé, portail |
| Périphériques | `GET, POST /kms/kiosks/{id}/devices` ; `GET, PATCH, DELETE …/devices/{deviceId}` | Portail |
| Statut et historique | `PUT …/devices/{deviceId}/status` ; `GET …/devices/{deviceId}/status-history` ; `GET /kms/kiosks/{id}/status-history` | Portail, supervision |
| Catalogue des périphériques | `GET, POST /kms/device-types` ; `GET, PATCH, DELETE /kms/device-types/{code}` | Portail (paramétrage) |
| Services | `GET, POST /kms/services` ; `GET, PATCH, DELETE /kms/services/{code}` | Portail (paramétrage) |
| Relations service ↔ périphérique | `GET /kms/services/{code}/device-requirements` ; `PUT, DELETE …/device-requirements/{deviceTypeCode}` | Portail (paramétrage) |
| Paramètres dépôt et retrait | `GET, PUT /kms/deposit-settings` ; `GET, PUT /kms/withdrawal-settings` | Kiosque (lecture), portail |
| Ouverture de compte (KYC) | `GET, POST /account-applications` ; `GET, PATCH …/{id}` ; `GET, POST …/documents` ; `DELETE …/documents/{documentId}` ; `POST …/phone-verification`, `…/confirm` ; `POST …/submit`, `…/decision`, `…/cancel` | Kiosque (libre-service), portail (agence, conformité) |

## Décisions

| # | Décision | Raison |
|---|---|---|
| D-1 | OpenAPI **3.1**, un seul fichier `openapi/openapi.yaml` | Les schémas sont du JSON Schema standard, directement validables (ajv) |
| D-2 | Préfixe `/api/v1` | Permet de faire évoluer la version de l'API sans casser les clients existants |
| D-3 | En-tête `X-Correlation-Id` (UUID) **obligatoire** sur chaque requête, renvoyé dans chaque réponse et chaque erreur | Traçabilité de bout en bout. Une requête sans cet en-tête reçoit une erreur 400 |
| D-4 | Un **format d'erreur unique** `Error {code, message, correlationId, retryable?, details?}` | L'interface réagit selon `code` et `retryable`. `message` est technique et ne doit pas être affiché tel quel |
| D-5 | Statuts : 400 requête invalide, 401 non authentifié, 403 rôle insuffisant, 404 introuvable, 409 conflit (doublon ou dépendance), 422 refus métier, 503 système aval indisponible, 504 délai aval dépassé | Chaque cas d'erreur correspond à un statut distinct |
| D-6 | En-tête `Idempotency-Key` obligatoire sur le dépôt et le retrait | Un renvoi après un délai dépassé ne doit pas exécuter l'opération deux fois |
| D-7 | Montants au format `Money {amount, currency}`, devise ISO 4217 (MAD) | Le format est explicite et prêt pour d'autres devises |
| D-8 | MSW comme mock principal, Prism en complément | MSW permet les scénarios pilotables et un état en mémoire, dans le navigateur comme dans les tests. Prism sert au partage avec curl, Postman ou le back-end |
| D-9 | Types et client générés (`openapi-typescript` + `openapi-fetch`). La CI vérifie que les types générés correspondent au contrat | Un écart avec le contrat provoque une erreur de compilation |
| D-10 | **`/terminals` est remplacé par `/kms/kiosks`**, et `terminalId` par `kioskId` (connexion, dépôt, transaction) | Un seul vocabulaire : le kiosque. Ce changement est autorisé car le contrat n'est pas encore gelé |
| D-11 | Les identifiants métier (kiosque, type de périphérique, service) sont choisis à la création, en majuscules (`^[A-Z0-9][A-Z0-9_-]{1,31}$`). Les identifiants des périphériques sont générés par le serveur | Codes lisibles dans le paramétrage et les logs, sans risque de collision pour les périphériques |
| D-12 | CRUD : `POST` → 201, `PATCH` partiel (les champs inconnus sont refusés), `DELETE` → 204 | Convention simple et uniforme |
| D-13 | Le statut d'un périphérique change **uniquement** par `PUT …/status`. Chaque changement crée une entrée d'historique (statut précédent, nouveau statut, motif, source, auteur, date, correlationId). Renvoyer le même statut et le même motif ne crée rien | Historique complet et fiable. L'appel peut être rejoué sans risque |
| D-14 | L'historique est **conservé** quand un périphérique ou un kiosque est supprimé | Besoin d'audit |
| D-15 | Trois niveaux d'exigence service ↔ type de périphérique : `MANDATORY`, `RECOMMENDED`, `OPTIONAL` (voir la règle dans le README) | Permet d'expliquer le mode dégradé : par exemple, un retrait sans imprimante reste possible, mais sans ticket |
| D-16 | La disponibilité des services et la santé du kiosque sont **calculées** par le serveur, jamais saisies | Une seule source de vérité, utilisée à la fois par le kiosque et par le portail |
| D-17 | Les paramètres dépôt et retrait sont **globaux** et lisibles par tout utilisateur connecté | Le kiosque affiche les limites et les montants rapides. Une surcharge par kiosque reste à décider (OQ-7) |
| D-18 | Un service intégré (`builtIn` : DEPOSIT, WITHDRAWAL, BALANCE, HISTORY, ACCOUNT_OPENING) ne peut pas être supprimé. Un service affecté à un kiosque, un type de périphérique installé ou demandé par un service, et un kiosque `ONLINE` ne peuvent pas non plus être supprimés (409) | Évite de casser la configuration en production |
| D-19 | **Ouverture de compte = un dossier** (`/account-applications`) avec un cycle de vie explicite : `DRAFT` → `APPROVED` / `UNDER_REVIEW` / `REJECTED`, ou `CANCELLED` | On peut le reprendre, l'auditer et le traiter en back-office. Le compte n'existe qu'une fois le dossier accepté |
| D-20 | Canal **KIOSK sans authentification** : la création renvoie un **token d'application** limité à ce seul dossier | Le prospect n'a ni carte ni compte. Le token limite l'exposition à son propre dossier |
| D-21 | KYC en deux temps : **complétude** (`422 APPLICATION_INCOMPLETE` avec la liste exhaustive de ce qui manque), puis **contrôles** (pièce, âge, visage, sanctions, PEP, client existant, FATCA) avec un **niveau de risque** | L'interface guide le prospect ; les contrôles sont traçables un par un dans `kyc.checks` |
| D-22 | Règle de décision : un `FAIL` → rejet automatique ; un `REVIEW` ou un risque `HIGH` → revue humaine ; sinon acceptation et ouverture immédiates | Approche par les risques : l'humain n'intervient que là où c'est nécessaire |
| D-23 | **Séparation des tâches** : seul le rôle `COMPLIANCE` décide d'un dossier en revue. Commentaire obligatoire, motif obligatoire pour un rejet, décision tracée (`decidedBy`, `decidedAt`) | Exigence de conformité et piste d'audit |
| D-24 | **Vérification du téléphone par code SMS** (10 minutes, 3 essais) ; changer le numéro annule la vérification | Le téléphone sert ensuite à l'authentification forte et aux alertes |
| D-25 | **Consentement explicite** au traitement des données (`consents.dataProcessing`) obligatoire pour soumettre ; consentement marketing séparé et facultatif | Loi 09-08 relative à la protection des données personnelles |
| D-26 | Pièces envoyées en base64 (JPEG, PNG, PDF, 5 Mo maximum), une par type ; l'API ne renvoie jamais leur contenu, seulement leurs métadonnées | Simplicité pour le MVP ; aucune fuite d'images d'identité par les lectures |
| D-27 | Service KMS intégré **`ACCOUNT_OPENING`** : écran, scanner de pièce et caméra obligatoires, imprimante recommandée | Le kiosque ne propose l'ouverture de compte que s'il est équipé |
| D-28 | Un rejet n'est **jamais motivé auprès du prospect** côté kiosque | Une alerte sanctions ne doit pas être révélée (risque de « tipping-off ») |

## Questions ouvertes

| # | Question | Responsable | Échéance |
|---|---|---|---|
| OQ-1 | Aligner `TransactionEnvelope` sur l'enveloppe générique de l'Epic 1 et sur le contrat du Routeur | Si Abdelkbir avec les responsables de l'Epic 1 et du Routeur | Lun. 12 oct. |
| OQ-2 | Authentification kiosque : le PIN est-il vérifié par l'Agent ou par le CBS ? Le format de la carte est-il PAN ou token ? | À définir | Lun. 12 oct. |
| OQ-3 | Durée de session (15 min dans le mock) et existence d'un refresh token | À définir | Lun. 12 oct. |
| OQ-4 | Codes d'erreur métier définitifs : liste fournie par le CBS ou le Routeur | À définir | Lun. 12 oct. |
| OQ-5 | Mode dégradé (Badr, 3.7) : `GET /kms/kiosks/{id}/services` couvre-t-il le besoin ? | Badr, Si Abdelkbir | Lun. 12 oct. |
| OQ-6 | Liste définitive des rôles du portail (Anis, 3.8), et matrice des droits KMS | Anis | Lun. 12 oct. |
| OQ-7 | Les paramètres dépôt et retrait doivent-ils être surchargeables par kiosque (par exemple selon la capacité des cassettes) ? | PO | Lun. 12 oct. |
| OQ-8 | Remontée automatique des statuts par le kiosque (source `DEVICE`) : quel moyen d'authentification pour l'Agent du kiosque (compte technique, certificat) ? | Back-end KMS | Lun. 12 oct. |
| OQ-9 | `ONLINE` / `OFFLINE` : saisi par un administrateur ou calculé par un heartbeat (`lastSeenAt`) ? Quel délai avant de passer `OFFLINE` ? | Back-end KMS | Lun. 12 oct. |
| OQ-10 | Durée de conservation de l'historique des statuts, et besoin d'export (CSV) | PO | Lun. 12 oct. |
| OQ-11 | Modifications concurrentes dans le portail : faut-il un contrôle optimiste (ETag / `If-Match`) ? | À définir | Lun. 12 oct. |
| OQ-12 | Fournisseurs réels des contrôles KYC : vérification de la CIN (DGSN ?), reconnaissance faciale, listes de sanctions et de PEP. Délais de réponse et fonctionnement asynchrone éventuel (statut intermédiaire « contrôles en cours ») | Back-end, Conformité | Lun. 12 oct. |
| OQ-13 | Seuils et règles du **niveau de risque** (revenus, profession, nationalité, origine des fonds) à valider par la Conformité ; revue périodique du KYC selon le risque | Conformité | À définir |
| OQ-14 | Après l'ouverture : émission de la carte, signature électronique du contrat, dépôt initial minimum, accès à la banque en ligne | PO | À définir |
| OQ-15 | **Conservation et purge** des pièces et des données (brouillons après 30 jours, dossiers rejetés), déclaration auprès de la CNDP, chiffrement des pièces au repos | Conformité, Sécurité | À définir |
| OQ-16 | Durée de vie et révocation du **token d'application** ; reprise d'un dossier interrompu sur un autre kiosque (par SMS ?) | Back-end | Lun. 12 oct. |
| OQ-17 | Envoi des pièces en `multipart/form-data` plutôt qu'en base64 si les fichiers dépassent régulièrement 1 Mo | Back-end | À définir |

## Risques

| Risque | Mesure |
|---|---|
| Le back-end implémente un comportement différent du mock | Le contrat fait référence, les règles de disponibilité sont documentées, et les tests de contrat pourront être rejoués contre le vrai back-end |
| Le contrat évolue après le gel et bloque le kiosque ou le portail | Toute évolution passe par une demande de changement (ci-dessous) |
| Les règles de disponibilité sont implémentées différemment côté kiosque et côté portail | Elles sont calculées par le serveur (D-16) ; le front ne fait qu'afficher le résultat |
| Des données sensibles apparaissent dans les fixtures | Les fixtures ne contiennent que des données fictives |

## Demande de changement (après le gel)

1. Ouvrir une issue intitulée `[API change] …` : motif, appel concerné, changement proposé (diff du YAML), changement compatible ou non.
2. Faire valider par les responsables concernés (kiosque, portail, back-end).
3. Ouvrir une PR qui modifie le contrat, les types générés, les handlers et les tests ensemble.
