# Guide des endpoints – API ALS (MVP)

Ce guide explique **à quoi sert chaque endpoint, quand l'appeler et comment il se comporte**. Il est destiné aux équipes kiosque, portail et back-end.

- La **référence technique** (schémas complets) est `openapi/openapi.yaml`, consultable dans Swagger : `npm run mock:server`, puis http://localhost:4000/docs.
- Ce guide décrit le **comportement attendu du back-end**. Le mock MSW l'implémente déjà : tous les exemples de réponse ci-dessous ont été produits par le mock.
- Pour essayer : Swagger (bouton *Try it out*) ou la collection Postman du dossier `postman/`.

## Sommaire

1. [Principes communs](#1-principes-communs)
2. [Concepts métier du KMS](#2-concepts-métier-du-kms)
3. [Parcours : comment les endpoints s'enchaînent](#3-parcours--comment-les-endpoints-senchaînent)
4. [Référence des endpoints](#4-référence-des-endpoints)
   - [4.1 Authentification](#41-authentification)
   - [4.2 Comptes](#42-comptes)
   - [4.3 Opérations : dépôt et retrait](#43-opérations--dépôt-et-retrait)
   - [4.4 KMS – Kiosques](#44-kms--kiosques)
   - [4.5 KMS – Services d'un kiosque](#45-kms--services-dun-kiosque)
   - [4.6 KMS – Périphériques](#46-kms--périphériques)
   - [4.7 KMS – Statut et historique des périphériques](#47-kms--statut-et-historique-des-périphériques)
   - [4.8 Paramétrage – Catalogue des types de périphériques](#48-paramétrage--catalogue-des-types-de-périphériques)
   - [4.9 Paramétrage – Services](#49-paramétrage--services)
   - [4.10 Paramétrage – Relations service ↔ périphérique](#410-paramétrage--relations-service--périphérique)
   - [4.11 Paramétrage – Dépôt et retrait](#411-paramétrage--dépôt-et-retrait)
5. [Codes d'erreur](#5-codes-derreur)
6. [Tableau récapitulatif des 38 endpoints](#6-tableau-récapitulatif-des-38-endpoints)

---

## 1. Principes communs

### URL de base

| Environnement | URL |
|---|---|
| Mock (`npm run mock:server`) | `http://localhost:4000/api/v1` |
| Application en développement (MSW dans le navigateur) | `/api/v1` (même origine) |
| Back-end réel | à définir, toujours sous `/api/v1` |

### En-têtes

| En-tête | Obligatoire | Rôle |
|---|---|---|
| `X-Correlation-Id` | **Toujours** | UUID généré par le front pour chaque action de l'utilisateur. Il suit la requête dans tous les systèmes (kiosque → Agent → Routeur → CBS) et revient dans la réponse et dans chaque erreur. C'est l'identifiant à communiquer au support. Sans lui, la réponse est `400 MISSING_CORRELATION_ID` |
| `Authorization: Bearer <token>` | Tous les appels sauf la connexion | Token obtenu par `POST /auth/login` |
| `Idempotency-Key` | Dépôt et retrait | UUID **unique par opération**. Si la requête est renvoyée avec la même clé (après un délai dépassé, par exemple), l'opération n'est pas exécutée une seconde fois : la réponse d'origine est renvoyée |
| `Content-Type: application/json` | Appels avec un corps | — |

### Rôles

| Rôle | Qui | Droits |
|---|---|---|
| `CUSTOMER` | Client connecté sur un kiosque (carte + PIN) | Ses comptes, dépôt, retrait, services du kiosque, paramètres dépôt et retrait (lecture) |
| `AGENT` | Agent d'agence (portail) | Lecture de tout le KMS |
| `SUPERVISOR` | Superviseur (portail) | Lecture du KMS, plus le **changement de statut** des périphériques |
| `ADMIN` | Administrateur (portail) | Tout, y compris la création, la modification et la suppression, et le paramétrage |

Un rôle insuffisant renvoie `403 FORBIDDEN`.

### Format des erreurs

Toutes les erreurs ont la même forme :

```json
{
  "code": "AMOUNT_NOT_MULTIPLE",
  "message": "Amount must be a multiple of 100",
  "correlationId": "3f1c1b0e-0000-4000-8000-000000000001",
  "retryable": false
}
```

| Champ | Usage côté front |
|---|---|
| `code` | **Ce sur quoi l'interface se base** pour choisir le message affiché (voir [§5](#5-codes-derreur)) |
| `message` | Message technique, pour les logs. **Ne pas l'afficher tel quel** à l'utilisateur |
| `correlationId` | À afficher en petit sur l'écran d'erreur (« Référence : … ») |
| `retryable` | `true` : on peut proposer « Réessayer » |
| `details` | Erreurs de validation champ par champ : `[{ "field": "amount.amount", "issue": "must be greater than 0" }]` |

### Codes HTTP

| Code | Signification |
|---|---|
| `200` | Succès |
| `201` | Créé (création, dépôt, retrait) |
| `204` | Supprimé (pas de corps) |
| `400` | Requête invalide : champ manquant ou mal formé, en-tête absent |
| `401` | Non authentifié, ou token expiré |
| `403` | Authentifié, mais rôle insuffisant |
| `404` | Ressource introuvable |
| `409` | Conflit : doublon, ou suppression bloquée par une dépendance |
| `422` | **Refus métier** : la requête est valide mais une règle l'interdit (plafond, solde, service indisponible…) |
| `503` | Un système en aval est indisponible : CBS pour les appels bancaires, KMS pour `/kms/*` |
| `504` | Un système en aval n'a pas répondu à temps |

### Conventions

- **Listes** : toujours sous la forme `{ "items": [...] }`.
- **Pagination** (historiques) : paramètre `limit` (1 à 100, 20 par défaut). Quand il reste des éléments, la réponse contient `nextCursor`, à renvoyer dans `cursor` pour obtenir la page suivante. `nextCursor` est absent sur la dernière page.
- **Création** : `POST` → `201` + l'objet créé. **Modification** : `PATCH` partiel, seuls les champs envoyés changent. Un champ inconnu renvoie `400`. **Suppression** : `DELETE` → `204`.
- **Identifiants métier** (kiosque, type de périphérique, service) : choisis à la création, en majuscules, 2 à 32 caractères parmi `A-Z 0-9 _ -`. Exemples : `KIOSK-01`, `CASH_ACCEPTOR`, `DEPOSIT`. Les identifiants de périphérique (`DEV-…`) sont générés par le serveur.
- **Montants** : `{ "amount": 200, "currency": "MAD" }`.
- **Dates** : ISO 8601 en UTC, par exemple `2026-10-05T07:40:00Z`.

---

## 2. Concepts métier du KMS

```
Type de périphérique (catalogue global)          Service (DEPOSIT, WITHDRAWAL…)
  CARD_READER, CASH_ACCEPTOR…                       │
        ▲                                           │ exige des types de périphériques,
        │ est de type                               │ chacun avec un niveau :
        │                                           │ MANDATORY / RECOMMENDED / OPTIONAL
Périphérique ──── installé sur ────► Kiosque ◄──── affecté à ────┘
  (statut + historique)                (statut, santé calculée, services affectés)
```

| Notion | Définition |
|---|---|
| **Kiosque** | Une borne physique, identifiée par `kioskId`, avec un `status` saisi (`ONLINE`, `OFFLINE`, `MAINTENANCE`) et une `health` **calculée** |
| **Type de périphérique** | Une entrée du catalogue global : lecteur de carte, accepteur de billets, imprimante… |
| **Périphérique** | Un appareil réel installé sur un kiosque : type, numéro de série, modèle, **statut** |
| **Service** | Une fonction proposée sur les kiosques : dépôt, retrait, solde, historique… |
| **Exigence** | Le lien entre un service et un type de périphérique, avec un niveau d'exigence |
| **Affectation** | Le fait qu'un service soit proposé sur un kiosque donné. Elle peut être désactivée localement |

### Statuts d'un périphérique

| Statut | Signification | Utilisable ? |
|---|---|---|
| `OPERATIONAL` | Fonctionne | ✅ |
| `WARNING` | Fonctionne, avec une alerte (papier bientôt épuisé, cassette presque pleine…) | ✅ |
| `ERROR` | En panne (bourrage, papier épuisé…) | ❌ |
| `OFFLINE` | Ne répond pas | ❌ |
| `MAINTENANCE` | En intervention | ❌ |
| `DISABLED` | Désactivé volontairement | ❌ |

### Règle de disponibilité d'un service sur un kiosque

Le serveur calcule la disponibilité ; le front ne fait que l'afficher.

1. Le service est **`UNAVAILABLE`** dans l'un de ces cas :
   - il est désactivé globalement (`SERVICE_DISABLED`) ;
   - il est désactivé sur ce kiosque (`SERVICE_DISABLED_ON_KIOSK`) ;
   - le kiosque n'est pas `ONLINE` (`KIOSK_NOT_ONLINE`).
2. Ensuite, pour chaque type de périphérique exigé par le service, quand le kiosque **n'a aucun périphérique utilisable** de ce type :

| Niveau d'exigence | Effet | Exemple |
|---|---|---|
| `MANDATORY` (obligatoire) | Service **`UNAVAILABLE`** | Dépôt sans accepteur de billets |
| `RECOMMENDED` (recommandé) | Service **`DEGRADED`** : il fonctionne avec des fonctions réduites | Retrait sans imprimante : pas de ticket |
| `OPTIONAL` (optionnel) | Service **`AVAILABLE`**, avec le problème signalé dans `issues` | Solde sans imprimante |

Chaque problème est expliqué dans `issues` avec un `reasonCode` : `DEVICE_MISSING` (aucun périphérique de ce type installé) ou `DEVICE_NOT_USABLE` (il y en a, mais aucun n'est utilisable).

### Santé d'un kiosque (`health`)

| Valeur | Quand |
|---|---|
| `OUT_OF_SERVICE` | Le kiosque n'est pas `ONLINE`, **ou** aucun de ses services n'est disponible |
| `DEGRADED` | Au moins un service n'est pas pleinement disponible, **ou** au moins un périphérique est inutilisable |
| `HEALTHY` | Dans tous les autres cas |

### Données de démonstration (mock)

| Kiosque | Situation | Effet |
|---|---|---|
| `KIOSK-01` (Casablanca) | Tout fonctionne | `HEALTHY` ; dépôt, retrait, solde et historique disponibles |
| `KIOSK-02` (Rabat) | Accepteur `DEV-0204` en `ERROR` (bourrage), imprimante `DEV-0206` en `ERROR` (papier) | `DEGRADED` ; dépôt `UNAVAILABLE`, retrait `DEGRADED`, solde `AVAILABLE` |
| `KIOSK-03` (Marrakech) | Kiosque `OFFLINE`, périphériques `OFFLINE`, pas de distributeur | `OUT_OF_SERVICE` |

---

## 3. Parcours : comment les endpoints s'enchaînent

> 📊 Les mêmes parcours sous forme de **schémas** (diagrammes de séquence, logigrammes, cycle de vie, modèle de données) : [`FLOWS.md`](FLOWS.md).

### 3.1 Kiosque : un client fait un retrait

```
1. Démarrage du kiosque (avant tout client)
   GET /kms/kiosks/KIOSK-01/services      → construit le menu : n'afficher que les services
                                            AVAILABLE ou DEGRADED
   GET /kms/withdrawal-settings           → montants rapides (200, 500, 1000, 2000), min, max
   GET /kms/deposit-settings              → billets acceptés, plafonds

2. Le client insère sa carte et tape son PIN
   POST /auth/login  {channel: KIOSK, cardNumber, pin, kioskId}  → accessToken, accountIds

3. Le client choisit « Retrait », puis un montant
   POST /withdrawals  + Idempotency-Key  → 201 : cashBreakdown = billets à distribuer
                                         → 422 : refus (code → message à l'écran)
   Si 504 (délai dépassé) : renvoyer la MÊME requête avec la MÊME Idempotency-Key.
   Il n'y a aucun risque de double retrait.

4. Ticket : si le service était DEGRADED à cause de l'imprimante, ne pas proposer de ticket.
```

Le dépôt suit le même parcours avec `POST /deposits`. Le kiosque peut envoyer les billets comptés dans `notes`.

### 3.2 Portail : un superviseur traite un incident

```
1. GET /kms/kiosks?health=DEGRADED                           → kiosques à problème
2. GET /kms/kiosks/KIOSK-02/services                         → quels services sont touchés, et pourquoi (issues)
3. GET /kms/kiosks/KIOSK-02/devices?status=ERROR             → périphériques en panne
4. GET /kms/kiosks/KIOSK-02/devices/DEV-0204/status-history  → depuis quand, et comment
5. Après réparation :
   PUT /kms/kiosks/KIOSK-02/devices/DEV-0204/status  {status: OPERATIONAL, reason: "Bourrage résolu"}
   → l'historique enregistre le changement (qui, quand, pourquoi)
   → le dépôt redevient AVAILABLE sur KIOSK-02, et la santé du kiosque est recalculée
```

### 3.3 Portail : un administrateur met en service un nouveau kiosque

```
1. POST /kms/kiosks                       {kioskId: "KIOSK-10", name, location}  → créé en MAINTENANCE
2. POST /kms/kiosks/KIOSK-10/devices      (une fois par périphérique : lecteur, PIN pad, écran, accepteur…)
3. PUT  /kms/kiosks/KIOSK-10/services/DEPOSIT     {enabled: true}   (une fois par service proposé)
4. GET  /kms/kiosks/KIOSK-10/services     → vérifier que tout est AVAILABLE (ou voir ce qui manque)
5. PATCH /kms/kiosks/KIOSK-10             {status: "ONLINE"}  → le kiosque est en service
```

### 3.4 Portail : un administrateur crée un nouveau service

```
1. POST /kms/device-types                 (si un nouveau type est nécessaire, par exemple BARCODE_SCANNER)
2. POST /kms/services                     {serviceCode: "BILL_PAYMENT", name: "Paiement de factures"}
3. PUT  /kms/services/BILL_PAYMENT/device-requirements/BARCODE_SCANNER   {requirement: MANDATORY}
4. PUT  /kms/kiosks/KIOSK-01/services/BILL_PAYMENT   {enabled: true}
```

---

## 4. Référence des endpoints

Pour chaque endpoint : à quoi il sert, qui peut l'appeler, ce qu'il attend, ce qu'il renvoie, et ses règles.

### 4.1 Authentification

#### `POST /auth/login` — Se connecter

**À quoi ça sert** : ouvrir une session et obtenir le token à envoyer dans `Authorization` sur tous les autres appels. Deux modes, selon `channel` :
- **`KIOSK`** : un client sur une borne, avec sa carte et son PIN ;
- **`PORTAL`** : un utilisateur du portail, avec son identifiant et son mot de passe.

**Rôle** : aucun (appel public).

```json
{ "channel": "KIOSK", "cardNumber": "4000000000000001", "pin": "1234", "kioskId": "KIOSK-01" }
```
```json
{ "channel": "PORTAL", "username": "superviseur", "password": "superviseur" }
```

**Réponse `200`**
```json
{
  "accessToken": "mock-token-U-CUST-1",
  "expiresAt": "2026-10-10T14:23:45.399Z",
  "user": { "id": "U-CUST-1", "displayName": "Client Démo", "roles": ["CUSTOMER"], "accountIds": ["ACC-001", "ACC-002"] }
}
```
- `roles` : sert au portail à afficher ou masquer les menus.
- `accountIds` : les comptes du client, présents uniquement pour un client.
- `expiresAt` : 15 minutes dans le mock. Durée réelle à confirmer (question OQ-3).

**Erreurs** : `401 INVALID_CREDENTIALS` (carte, PIN ou mot de passe faux) · `503` · `504`.

### 4.2 Comptes

#### `GET /accounts/{accountId}/balance` — Consulter le solde

**À quoi ça sert** : afficher le solde d'un compte (service « Solde » du kiosque).
**Rôle** : tout utilisateur connecté. Un client ne voit que **ses** comptes : un autre compte renvoie `404`, sans révéler qu'il existe.

**Réponse `200`**
```json
{
  "accountId": "ACC-001",
  "available": { "amount": 1520.5, "currency": "MAD" },
  "ledger": { "amount": 1520.5, "currency": "MAD" },
  "asOf": "2026-10-05T08:00:00Z"
}
```
- `available` : solde **disponible**, c'est celui qui limite un retrait.
- `ledger` : solde **comptable**, qui inclut les opérations en attente.

**Erreurs** : `404 ACCOUNT_NOT_FOUND` · `401` · `503 CBS_UNAVAILABLE` · `504`.

#### `GET /accounts/{accountId}/transactions` — Historique des opérations

**À quoi ça sert** : afficher les dernières opérations du compte, **les plus récentes d'abord** (service « Historique »).
**Rôle** : comme pour le solde.
**Paramètres** : `limit` (1 à 100, 20 par défaut), `cursor` (pagination, voir [§1](#conventions)).

**Réponse `200`** (extrait)
```json
{
  "items": [
    {
      "transactionId": "TX-1024",
      "correlationId": "00000000-0000-4000-8000-000000000024",
      "type": "DEPOSIT",
      "status": "ACCEPTED",
      "accountId": "ACC-001",
      "kioskId": "KIOSK-01",
      "amount": { "amount": 290, "currency": "MAD" },
      "createdAt": "2026-09-25T10:00:00.000Z"
    }
  ],
  "nextCursor": "5"
}
```

**Erreurs** : `400 INVALID_PAGINATION` · `404 ACCOUNT_NOT_FOUND` · `401` · `503` · `504`.

### 4.3 Opérations : dépôt et retrait

Les deux opérations suivent **les mêmes étapes**, dans cet ordre :

| # | Contrôle | Échec |
|---|---|---|
| 1 | En-têtes `X-Correlation-Id` et `Idempotency-Key` présents | `400` |
| 2 | `Idempotency-Key` déjà utilisée **pour la même opération** → renvoie l'opération d'origine, sans rien refaire | — (`201`) |
| 3 | Corps valide : montant > 0, devise du paramétrage, kiosque connu, compte accessible | `400` avec `details` |
| 4 | Service (`DEPOSIT` ou `WITHDRAWAL`) affecté au kiosque et non `UNAVAILABLE` | `422 SERVICE_UNAVAILABLE_ON_KIOSK` |
| 5 | Montant ≥ minimum | `422 AMOUNT_BELOW_MINIMUM` |
| 6 | Montant ≤ maximum par opération | `422 AMOUNT_ABOVE_MAXIMUM` |
| 7 | Total du jour + montant ≤ plafond journalier du compte | `422 DAILY_LIMIT_EXCEEDED` |
| 8 | Règles propres à l'opération (ci-dessous) | `422` |

Un service `DEGRADED` **n'empêche pas** l'opération : par exemple, un retrait reste possible sans imprimante.

#### `POST /deposits` — Faire un dépôt

**À quoi ça sert** : créditer un compte avec des billets insérés dans le kiosque.
**Rôle** : tout utilisateur connecté (en pratique, le client sur le kiosque).
**En-têtes** : `Idempotency-Key` obligatoire.

```json
{
  "accountId": "ACC-001",
  "kioskId": "KIOSK-01",
  "amount": { "amount": 200, "currency": "MAD" },
  "notes": [{ "denomination": 100, "count": 2 }]
}
```
`notes` (optionnel) : les billets comptés par l'accepteur. S'il est fourni :
- leur total doit être égal à `amount` (sinon `400`) ;
- chaque coupure doit être acceptée (sinon `422 DENOMINATION_NOT_ACCEPTED`) ;
- le nombre de billets ne doit pas dépasser le maximum (sinon `422 TOO_MANY_NOTES`).

**Réponse `201`** : le solde du compte augmente, et l'opération apparaît en tête de l'historique.
```json
{
  "transactionId": "TX-1001",
  "correlationId": "3f1c1b0e-0000-4000-8000-000000000001",
  "type": "DEPOSIT",
  "status": "ACCEPTED",
  "accountId": "ACC-001",
  "kioskId": "KIOSK-01",
  "amount": { "amount": 200, "currency": "MAD" },
  "cashBreakdown": [{ "denomination": 100, "count": 2 }],
  "createdAt": "2026-10-10T14:08:45.435Z"
}
```

**Erreurs propres** : `400 INVALID_DEPOSIT`, `400 MISSING_IDEMPOTENCY_KEY`, `422` (`SERVICE_UNAVAILABLE_ON_KIOSK`, `AMOUNT_BELOW_MINIMUM`, `AMOUNT_ABOVE_MAXIMUM`, `DAILY_LIMIT_EXCEEDED`, `DENOMINATION_NOT_ACCEPTED`, `TOO_MANY_NOTES`), `503 CBS_UNAVAILABLE`, `504`.

#### `POST /withdrawals` — Faire un retrait

**À quoi ça sert** : débiter un compte et indiquer au distributeur **quels billets sortir**.
**Rôle** : tout utilisateur connecté. **En-têtes** : `Idempotency-Key` obligatoire.

```json
{ "accountId": "ACC-001", "kioskId": "KIOSK-01", "amount": { "amount": 700, "currency": "MAD" } }
```

**Règles propres**, en plus des étapes communes :
- le montant doit être un multiple de `amountMultipleOf` (100 par défaut), sinon `422 AMOUNT_NOT_MULTIPLE` ;
- il doit pouvoir être composé avec les billets chargés, sinon `422 AMOUNT_NOT_DISPENSABLE` ;
- le nombre de billets ne doit pas dépasser le maximum, sinon `422 TOO_MANY_NOTES` ;
- le solde **disponible** doit être suffisant, sinon `422 INSUFFICIENT_FUNDS`.

**Réponse `201`** : `cashBreakdown` donne les billets à distribuer, avec le moins de billets possible (les plus grosses coupures d'abord). Pour 700 MAD avec des billets de 100 et 200 : 3 × 200 + 1 × 100.
```json
{
  "transactionId": "TX-1002",
  "type": "WITHDRAWAL",
  "status": "ACCEPTED",
  "accountId": "ACC-001",
  "kioskId": "KIOSK-01",
  "amount": { "amount": 700, "currency": "MAD" },
  "cashBreakdown": [{ "denomination": 200, "count": 3 }, { "denomination": 100, "count": 1 }],
  "correlationId": "…",
  "createdAt": "…"
}
```

**Exemple de refus `422`**
```json
{ "code": "AMOUNT_NOT_MULTIPLE", "message": "Amount must be a multiple of 100", "correlationId": "…", "retryable": false }
```

### 4.4 KMS – Kiosques

#### `GET /kms/kiosks` — Lister les kiosques

**À quoi ça sert** : alimenter le tableau de bord du portail (liste, carte, alertes).
**Rôle** : AGENT, SUPERVISOR, ADMIN.
**Filtres** (optionnels, combinables) : `status` (`ONLINE` / `OFFLINE` / `MAINTENANCE`), `health` (`HEALTHY` / `DEGRADED` / `OUT_OF_SERVICE`), `city` (sans tenir compte des majuscules), `q` (recherche dans l'identifiant et le nom).

**Réponse `200`** : `GET /kms/kiosks?health=DEGRADED`
```json
{
  "items": [
    {
      "kioskId": "KIOSK-02",
      "name": "Kiosque Agence Agdal",
      "location": { "branchCode": "AG-002", "branchName": "Agence Agdal", "city": "Rabat" },
      "ipAddress": "10.10.2.21",
      "softwareVersion": "0.1.0",
      "status": "ONLINE",
      "health": "DEGRADED",
      "deviceCount": 6,
      "lastSeenAt": "2026-10-05T07:55:00Z",
      "createdAt": "2026-09-01T08:00:00Z",
      "updatedAt": "2026-09-01T08:00:00Z"
    }
  ]
}
```
`health` et `deviceCount` sont **calculés** : on ne peut pas les modifier.

#### `POST /kms/kiosks` — Créer un kiosque

**À quoi ça sert** : déclarer une nouvelle borne.
**Rôle** : ADMIN.

```json
{
  "kioskId": "KIOSK-10",
  "name": "Kiosque Fès",
  "location": { "branchCode": "AG-010", "branchName": "Agence Fès", "address": "…", "city": "Fès" },
  "ipAddress": "10.10.10.21",
  "softwareVersion": "0.2.0"
}
```
Champs obligatoires : `kioskId`, `name`, `location.branchName`, `location.city`. Le kiosque est créé en **`MAINTENANCE`** par défaut, le temps de le configurer.

**Réponse `201`** : le kiosque, avec `health: OUT_OF_SERVICE` (il n'est pas encore `ONLINE`) et `deviceCount: 0`.
**Erreurs** : `400` (identifiant au mauvais format, champ manquant, adresse IP invalide, champ inconnu) · `409 KIOSK_ALREADY_EXISTS`.

#### `GET /kms/kiosks/{kioskId}` — Détail d'un kiosque

**Rôle** : AGENT, SUPERVISOR, ADMIN. **Réponse `200`** : le même objet qu'un élément de la liste. **Erreur** : `404 KIOSK_NOT_FOUND`.

#### `PATCH /kms/kiosks/{kioskId}` — Modifier un kiosque

**À quoi ça sert** : renommer, déplacer, mettre à jour la version, et surtout **changer le statut** : mise en service (`ONLINE`), maintenance (`MAINTENANCE`), hors ligne (`OFFLINE`).
**Rôle** : ADMIN.

```json
{ "status": "ONLINE", "softwareVersion": "0.2.0" }
```
Seuls les champs envoyés changent. Champs modifiables : `name`, `location`, `ipAddress`, `softwareVersion`, `status`.
**Effet** : la santé et la disponibilité des services sont recalculées immédiatement. Par exemple, un passage en `MAINTENANCE` rend tous les services `UNAVAILABLE`.
**Erreurs** : `400` (aucun champ envoyé, ou champ inconnu) · `404`.

#### `DELETE /kms/kiosks/{kioskId}` — Supprimer un kiosque

**Rôle** : ADMIN.
**Règle** : **refusé si le kiosque est `ONLINE`** (`409 KIOSK_ONLINE`) : il faut d'abord le passer en `MAINTENANCE` ou `OFFLINE`.
**Effet** : supprime ses périphériques et ses affectations de services. **L'historique des statuts est conservé**, pour l'audit.
**Réponse** : `204`. **Erreurs** : `404` · `409 KIOSK_ONLINE`.

### 4.5 KMS – Services d'un kiosque

#### `GET /kms/kiosks/{kioskId}/services` — Services du kiosque et leur disponibilité

**À quoi ça sert** : c'est **l'appel central du mode dégradé**.
- Le **kiosque** construit son menu avec : il n'affiche que les services disponibles.
- Le **portail** l'utilise pour expliquer pourquoi un service est indisponible.

**Rôle** : **tout utilisateur connecté**, y compris le client sur le kiosque.

**Réponse `200`** : `KIOSK-02`, avec l'accepteur et l'imprimante en panne (extrait)
```json
{
  "items": [
    {
      "serviceCode": "DEPOSIT",
      "name": "Dépôt",
      "enabled": true,
      "availability": "UNAVAILABLE",
      "issues": [
        { "reasonCode": "DEVICE_NOT_USABLE", "message": "CASH_ACCEPTOR is ERROR", "deviceTypeCode": "CASH_ACCEPTOR", "requirement": "MANDATORY" },
        { "reasonCode": "DEVICE_NOT_USABLE", "message": "RECEIPT_PRINTER is ERROR", "deviceTypeCode": "RECEIPT_PRINTER", "requirement": "OPTIONAL" }
      ],
      "assignedAt": "2026-09-01T08:00:00Z"
    },
    {
      "serviceCode": "WITHDRAWAL",
      "name": "Retrait",
      "enabled": true,
      "availability": "DEGRADED",
      "issues": [
        { "reasonCode": "DEVICE_NOT_USABLE", "message": "RECEIPT_PRINTER is ERROR", "deviceTypeCode": "RECEIPT_PRINTER", "requirement": "RECOMMENDED" }
      ],
      "assignedAt": "2026-09-01T08:00:00Z"
    },
    {
      "serviceCode": "BALANCE",
      "name": "Consultation du solde",
      "enabled": true,
      "availability": "AVAILABLE",
      "issues": [
        { "reasonCode": "DEVICE_NOT_USABLE", "message": "RECEIPT_PRINTER is ERROR", "deviceTypeCode": "RECEIPT_PRINTER", "requirement": "OPTIONAL" }
      ],
      "assignedAt": "2026-09-01T08:00:00Z"
    }
  ]
}
```

| `availability` | Ce que fait le kiosque |
|---|---|
| `AVAILABLE` | Affiche le service normalement |
| `DEGRADED` | Affiche le service avec un avertissement (par exemple « Ticket indisponible ») |
| `UNAVAILABLE` | Masque ou grise le service |

`issues` explique pourquoi. Les problèmes bloquants sont listés en premier (cause globale ou exigence `MANDATORY`), puis les `RECOMMENDED`, puis les `OPTIONAL`.

**Erreurs** : `404 KIOSK_NOT_FOUND` · `503 KMS_UNAVAILABLE`.

#### `PUT /kms/kiosks/{kioskId}/services/{serviceCode}` — Affecter un service à un kiosque

**À quoi ça sert** : proposer un service sur un kiosque, ou l'activer et le désactiver **sur ce kiosque seulement**.
**Rôle** : ADMIN.

```json
{ "enabled": true }
```
Cet appel crée l'affectation si elle n'existe pas, sinon il la met à jour. Il renvoie le service avec sa disponibilité calculée : on voit tout de suite s'il manque un périphérique.
**Erreurs** : `404` (kiosque ou service inconnu) · `400`.

#### `DELETE /kms/kiosks/{kioskId}/services/{serviceCode}` — Retirer un service d'un kiosque

**Rôle** : ADMIN. **Réponse** : `204`. **Erreur** : `404 KIOSK_SERVICE_NOT_FOUND` si le service n'était pas affecté à ce kiosque.

### 4.6 KMS – Périphériques

#### `GET /kms/kiosks/{kioskId}/devices` — Périphériques d'un kiosque

**À quoi ça sert** : l'inventaire de la borne et l'état de chaque appareil.
**Rôle** : AGENT, SUPERVISOR, ADMIN. **Filtre** : `status` (par exemple `?status=ERROR`).

**Réponse `200`** (extrait)
```json
{
  "items": [
    {
      "deviceId": "DEV-0204",
      "kioskId": "KIOSK-02",
      "deviceTypeCode": "CASH_ACCEPTOR",
      "serialNumber": "SN-02-CASH_ACCEPTOR",
      "manufacturer": "Demo Devices",
      "model": "CASH_ACCEPTOR-X1",
      "firmwareVersion": "1.0.0",
      "status": "ERROR",
      "statusReasonCode": "JAM",
      "statusReason": "Billet coincé",
      "statusChangedAt": "2026-10-05T07:40:00Z",
      "installedAt": "2026-09-01T08:00:00Z",
      "updatedAt": "2026-10-05T07:40:00Z"
    }
  ]
}
```

#### `POST /kms/kiosks/{kioskId}/devices` — Installer un périphérique

**Rôle** : ADMIN.
```json
{ "deviceTypeCode": "RECEIPT_PRINTER", "serialNumber": "SN-NEW-1", "manufacturer": "…", "model": "TP-80", "firmwareVersion": "2.1", "status": "OPERATIONAL" }
```
- `deviceTypeCode` doit exister dans le catalogue ([§4.8](#48-paramétrage--catalogue-des-types-de-périphériques)), sinon `400`.
- `status` est optionnel : `OPERATIONAL` par défaut.
- Le **statut initial est enregistré dans l'historique** (motif « Installation »).
- Le `deviceId` est généré par le serveur.

**Réponse `201`**. **Erreurs** : `400` · `404` (kiosque inconnu) · `409 DEVICE_SERIAL_EXISTS` (même type et même numéro de série déjà installés, sur ce kiosque ou un autre).

#### `GET /kms/kiosks/{kioskId}/devices/{deviceId}` — Détail d'un périphérique

**Rôle** : AGENT, SUPERVISOR, ADMIN. **Erreur** : `404 DEVICE_NOT_FOUND`.

#### `PATCH /kms/kiosks/{kioskId}/devices/{deviceId}` — Modifier un périphérique

**À quoi ça sert** : corriger le numéro de série, le modèle, le fabricant, ou mettre à jour le firmware.
**Rôle** : ADMIN.
```json
{ "firmwareVersion": "1.0.1" }
```
⚠️ **Le statut ne se modifie pas ici** : envoyer `status` renvoie `400` (champ inconnu). Il faut passer par `PUT …/status` ([§4.7](#47-kms--statut-et-historique-des-périphériques)) pour que l'historique soit alimenté.
**Erreurs** : `400` · `404` · `409 DEVICE_SERIAL_EXISTS`.

#### `DELETE /kms/kiosks/{kioskId}/devices/{deviceId}` — Retirer un périphérique

**Rôle** : ADMIN. **Réponse** : `204`.
**Effet** : la disponibilité des services du kiosque est recalculée. Par exemple, sans distributeur, le retrait devient `UNAVAILABLE` avec `DEVICE_MISSING`. **L'historique du périphérique est conservé.**

### 4.7 KMS – Statut et historique des périphériques

#### `PUT /kms/kiosks/{kioskId}/devices/{deviceId}/status` — Changer le statut d'un périphérique

**À quoi ça sert** : déclarer une panne, une réparation, une mise en maintenance… C'est **le seul moyen** de changer un statut.
**Rôle** : **SUPERVISOR, ADMIN**.

```json
{ "status": "OPERATIONAL", "reasonCode": "FIXED", "reason": "Bourrage résolu", "source": "OPERATOR" }
```

| Champ | Obligatoire | Description |
|---|---|---|
| `status` | Oui | Le nouveau statut (voir [§2](#statuts-dun-périphérique)) |
| `reasonCode` | Non | Code machine : `JAM`, `PAPER_LOW`, `OUT_OF_PAPER`, `NOT_RESPONDING`… |
| `reason` | Non | Explication en clair |
| `source` | Non | `OPERATOR` (par défaut), `DEVICE` (remonté par l'appareil) ou `SYSTEM` |

**Effets** :
1. une **entrée d'historique** est créée, avec le statut précédent, le nouveau statut, le motif, la source, l'auteur (`changedBy`, quand la source est `OPERATOR`), la date et le `correlationId` ;
2. la **disponibilité des services** et la **santé du kiosque** sont recalculées immédiatement.

**Renvoyer le même statut avec le même `reasonCode` ne fait rien** : aucune entrée d'historique n'est créée. L'appel peut donc être rejoué sans risque.

**Réponse `200`** : le périphérique avec son nouveau statut.
**Erreurs** : `400` (statut inconnu) · `403` (rôle AGENT) · `404`.

#### `GET /kms/kiosks/{kioskId}/devices/{deviceId}/status-history` — Historique d'un périphérique

**À quoi ça sert** : retracer la vie d'un appareil, par exemple combien de pannes en un mois.
**Rôle** : AGENT, SUPERVISOR, ADMIN.
**Filtres** : `from` (inclus), `to` (exclu), au format date ISO. Plus `limit` et `cursor`. Tri : **les plus récents d'abord**.
L'historique reste disponible **même si le périphérique a été retiré**.

#### `GET /kms/kiosks/{kioskId}/status-history` — Historique de tout un kiosque

**À quoi ça sert** : le journal des incidents d'une borne, tous périphériques confondus, y compris ceux qui ont été retirés.
**Rôle** : AGENT, SUPERVISOR, ADMIN.
**Filtres** : `deviceTypeCode`, `status` (changements **vers** ce statut), `from`, `to`, `limit`, `cursor`.

**Réponse `200`** : `GET /kms/kiosks/KIOSK-02/status-history?status=ERROR`
```json
{
  "items": [
    {
      "changeId": "CHG-0016",
      "kioskId": "KIOSK-02",
      "deviceId": "DEV-0206",
      "deviceTypeCode": "RECEIPT_PRINTER",
      "previousStatus": "WARNING",
      "newStatus": "ERROR",
      "reasonCode": "OUT_OF_PAPER",
      "reason": "Papier épuisé",
      "source": "DEVICE",
      "changedAt": "2026-10-05T07:50:00Z",
      "correlationId": "00000000-0000-4000-9000-000000000016"
    },
    {
      "changeId": "CHG-0012",
      "kioskId": "KIOSK-02",
      "deviceId": "DEV-0204",
      "deviceTypeCode": "CASH_ACCEPTOR",
      "previousStatus": "WARNING",
      "newStatus": "ERROR",
      "reasonCode": "JAM",
      "reason": "Billet coincé",
      "source": "DEVICE",
      "changedAt": "2026-10-05T07:40:00Z",
      "correlationId": "00000000-0000-4000-9000-000000000012"
    }
  ]
}
```
`previousStatus` est absent pour l'entrée d'installation. `changedBy` contient l'identifiant de l'utilisateur quand `source = OPERATOR`.
**Erreurs** : `400` (date invalide) · `404` (kiosque inconnu et sans historique).

### 4.8 Paramétrage – Catalogue des types de périphériques

Le catalogue est la **liste globale** des types de périphériques connus du système. Tout périphérique installé et toute exigence de service y font référence.

| Endpoint | Rôle | Description |
|---|---|---|
| `GET /kms/device-types` | AGENT, SUPERVISOR, ADMIN | Liste. Filtre `category` : `CASH`, `CARD`, `PRINTER`, `INPUT`, `DISPLAY`, `SENSOR`, `OTHER` |
| `POST /kms/device-types` | ADMIN | Ajoute un type : `{ "deviceTypeCode": "NFC_READER", "name": "Lecteur NFC", "category": "CARD", "description": "…" }` → `201`, ou `409 DEVICE_TYPE_ALREADY_EXISTS` |
| `GET /kms/device-types/{code}` | AGENT, SUPERVISOR, ADMIN | Détail, ou `404 DEVICE_TYPE_NOT_FOUND` |
| `PATCH /kms/device-types/{code}` | ADMIN | Modifie `name`, `category` ou `description`. Le code ne change pas |
| `DELETE /kms/device-types/{code}` | ADMIN | Supprime → `204`. **Refusé (`409 DEVICE_TYPE_IN_USE`)** si un périphérique de ce type est installé ou si un service l'exige |

Catalogue de démonstration : `CARD_READER`, `PIN_PAD`, `TOUCH_SCREEN`, `CASH_ACCEPTOR`, `CASH_DISPENSER`, `RECEIPT_PRINTER`, `BARCODE_SCANNER`, `CAMERA`.

### 4.9 Paramétrage – Services

| Endpoint | Rôle | Description |
|---|---|---|
| `GET /kms/services` | AGENT, SUPERVISOR, ADMIN | Tous les services, avec leurs exigences |
| `POST /kms/services` | ADMIN | Crée un service : `{ "serviceCode": "BILL_PAYMENT", "name": "Paiement de factures", "description": "…", "enabled": true }` → `201`. Il est créé **sans exigence** ; `enabled` vaut `true` par défaut. `409 SERVICE_ALREADY_EXISTS` si le code existe déjà |
| `GET /kms/services/{code}` | AGENT, SUPERVISOR, ADMIN | Détail, avec `deviceRequirements` |
| `PATCH /kms/services/{code}` | ADMIN | Modifie `name`, `description`, `enabled`. **`enabled: false` désactive le service sur tous les kiosques** : il devient `UNAVAILABLE` avec `SERVICE_DISABLED` |
| `DELETE /kms/services/{code}` | ADMIN | → `204`. **Refusé** pour un service intégré (`409 SERVICE_BUILT_IN` : DEPOSIT, WITHDRAWAL, BALANCE, HISTORY) ou affecté à un kiosque (`409 SERVICE_ASSIGNED` : le retirer des kiosques d'abord) |

**Exemple** : `GET /kms/services/WITHDRAWAL`
```json
{
  "serviceCode": "WITHDRAWAL",
  "name": "Retrait",
  "enabled": true,
  "builtIn": true,
  "deviceRequirements": [
    { "deviceTypeCode": "CARD_READER", "requirement": "MANDATORY" },
    { "deviceTypeCode": "PIN_PAD", "requirement": "MANDATORY" },
    { "deviceTypeCode": "TOUCH_SCREEN", "requirement": "MANDATORY" },
    { "deviceTypeCode": "CASH_DISPENSER", "requirement": "MANDATORY" },
    { "deviceTypeCode": "RECEIPT_PRINTER", "requirement": "RECOMMENDED" }
  ],
  "createdAt": "2026-09-01T08:00:00Z",
  "updatedAt": "2026-09-01T08:00:00Z"
}
```

### 4.10 Paramétrage – Relations service ↔ périphérique

Ces relations définissent **de quoi un service a besoin**, et à quel point (voir la [règle de disponibilité](#règle-de-disponibilité-dun-service-sur-un-kiosque)).

| Endpoint | Rôle | Description |
|---|---|---|
| `GET /kms/services/{serviceCode}/device-requirements` | AGENT, SUPERVISOR, ADMIN | Les types exigés et leur niveau |
| `PUT /kms/services/{serviceCode}/device-requirements/{deviceTypeCode}` | ADMIN | Crée le lien, ou change son niveau : `{ "requirement": "MANDATORY" \| "RECOMMENDED" \| "OPTIONAL" }` → `200`. `404` si le service ou le type n'existe pas |
| `DELETE /kms/services/{serviceCode}/device-requirements/{deviceTypeCode}` | ADMIN | Supprime le lien → `204`. `404` si ce lien n'existe pas |

**Effet immédiat sur tous les kiosques.** Par exemple, si l'on passe `CASH_ACCEPTOR` de `MANDATORY` à `RECOMMENDED` pour `DEPOSIT`, le dépôt sur `KIOSK-02` (accepteur en panne) passe de `UNAVAILABLE` à `DEGRADED`.

Exigences de démonstration :

| Service | Obligatoire | Recommandé | Optionnel |
|---|---|---|---|
| `DEPOSIT` | lecteur de carte, PIN pad, écran, accepteur de billets | — | imprimante |
| `WITHDRAWAL` | lecteur de carte, PIN pad, écran, distributeur de billets | imprimante | — |
| `BALANCE`, `HISTORY` | lecteur de carte, PIN pad, écran | — | imprimante |
| `STATEMENT` (non intégré, non affecté) | lecteur de carte, PIN pad, écran, imprimante | — | — |

### 4.11 Paramétrage – Dépôt et retrait

Ce sont les règles appliquées par `POST /deposits` et `POST /withdrawals`. Elles sont **globales** : une surcharge par kiosque reste à décider (question OQ-7).

| Endpoint | Rôle | Description |
|---|---|---|
| `GET /kms/deposit-settings` | **Tout utilisateur connecté** | Le kiosque les lit pour afficher les limites et les billets acceptés |
| `PUT /kms/deposit-settings` | ADMIN | **Remplace** tous les paramètres (tous les champs sont obligatoires) |
| `GET /kms/withdrawal-settings` | **Tout utilisateur connecté** | Le kiosque les lit pour afficher les montants rapides |
| `PUT /kms/withdrawal-settings` | ADMIN | Remplace tous les paramètres |

**Paramètres du dépôt**

| Champ | Démo | Rôle |
|---|---|---|
| `currency` | `MAD` | Devise acceptée |
| `minAmount` | 50 | Montant minimum par dépôt |
| `maxAmountPerTransaction` | 20 000 | Montant maximum par dépôt |
| `dailyLimitPerAccount` | 50 000 | Total maximum déposé par compte et par jour |
| `acceptedDenominations` | 20, 50, 100, 200 | Billets acceptés par l'accepteur |
| `maxNotesPerTransaction` | 200 | Nombre maximum de billets par dépôt |
| `receiptMode` | `ON_REQUEST` | Ticket : `ALWAYS` (toujours), `ON_REQUEST` (si le client le demande), `NEVER` (jamais) |

**Paramètres du retrait** : les mêmes, plus :

| Champ | Démo | Rôle |
|---|---|---|
| `amountMultipleOf` | 100 | Le montant doit en être un multiple (c'est le plus petit billet distribuable) |
| `dispensableDenominations` | 100, 200 | Billets chargés dans le distributeur |
| `presetAmounts` | 200, 500, 1000, 2000 | Boutons de montant rapide sur le kiosque |

**Contrôles à l'enregistrement** (`400` sinon) :
- `minAmount ≤ maxAmountPerTransaction ≤ dailyLimitPerAccount` ;
- les coupures sont des entiers positifs, sans doublon ;
- pour le retrait :
  - chaque billet est un multiple de `amountMultipleOf` ;
  - chaque montant rapide est compris entre le minimum et le maximum, et est un multiple de `amountMultipleOf`.

---

## 5. Codes d'erreur

Les messages proposés dans ce tableau sont des suggestions pour l'interface.

| Code | HTTP | Signification | Côté interface |
|---|---|---|---|
| `MISSING_CORRELATION_ID` | 400 | En-tête `X-Correlation-Id` absent | Bug du front : à corriger |
| `MISSING_IDEMPOTENCY_KEY` | 400 | En-tête `Idempotency-Key` absent (dépôt, retrait) | Bug du front |
| `INVALID_REQUEST`, `INVALID_DEPOSIT`, `INVALID_WITHDRAWAL` | 400 | Corps invalide ; voir `details` | Mettre en évidence les champs en erreur |
| `INVALID_PAGINATION` | 400 | `limit` ou `cursor` invalide | Bug du front |
| `INVALID_CREDENTIALS` | 401 | Carte, PIN ou mot de passe incorrect | « Code incorrect » |
| `UNAUTHORIZED` | 401 | Token absent, invalide ou expiré | Revenir à l'écran de connexion |
| `FORBIDDEN` | 403 | Rôle insuffisant | Masquer l'action dans l'interface |
| `ACCOUNT_NOT_FOUND`, `KIOSK_NOT_FOUND`, `DEVICE_NOT_FOUND`, `DEVICE_TYPE_NOT_FOUND`, `SERVICE_NOT_FOUND`, `KIOSK_SERVICE_NOT_FOUND`, `SERVICE_DEVICE_REQUIREMENT_NOT_FOUND` | 404 | Ressource introuvable | « Élément introuvable », puis rafraîchir la liste |
| `KIOSK_ALREADY_EXISTS`, `DEVICE_TYPE_ALREADY_EXISTS`, `SERVICE_ALREADY_EXISTS` | 409 | Ce code est déjà utilisé | « Cet identifiant existe déjà » |
| `DEVICE_SERIAL_EXISTS` | 409 | Numéro de série déjà installé pour ce type | « Ce périphérique est déjà installé » |
| `KIOSK_ONLINE` | 409 | Suppression d'un kiosque en ligne | « Mettez le kiosque en maintenance d'abord » |
| `DEVICE_TYPE_IN_USE` | 409 | Type installé ou exigé par un service | Afficher `message` (il dit par quoi) |
| `SERVICE_BUILT_IN` | 409 | Service intégré, non supprimable | Désactiver plutôt (`enabled: false`) |
| `SERVICE_ASSIGNED` | 409 | Service encore affecté à des kiosques | Le retirer des kiosques d'abord |
| `SERVICE_UNAVAILABLE_ON_KIOSK` | 422 | Service indisponible sur ce kiosque | « Service momentanément indisponible » ; rafraîchir le menu |
| `AMOUNT_BELOW_MINIMUM` / `AMOUNT_ABOVE_MAXIMUM` | 422 | Hors des limites par opération | Afficher les limites (lues dans les paramètres) |
| `DAILY_LIMIT_EXCEEDED` | 422 | Plafond journalier atteint | « Plafond journalier atteint » |
| `AMOUNT_NOT_MULTIPLE` | 422 | Retrait qui n'est pas un multiple de 100 | « Saisissez un multiple de 100 » |
| `AMOUNT_NOT_DISPENSABLE` | 422 | Montant impossible avec les billets chargés | Proposer un autre montant |
| `DENOMINATION_NOT_ACCEPTED` | 422 | Billet non accepté (dépôt) | Rendre les billets refusés |
| `TOO_MANY_NOTES` | 422 | Trop de billets | « Montant trop élevé pour une seule opération » |
| `INSUFFICIENT_FUNDS` | 422 | Solde disponible insuffisant | « Solde insuffisant » |
| `CBS_UNAVAILABLE` | 503 | Système bancaire central indisponible (`retryable: true`) | « Service momentanément indisponible, réessayez » |
| `KMS_UNAVAILABLE` | 503 | KMS indisponible (`retryable: true`) | Portail : bandeau d'alerte. Kiosque : garder le dernier menu connu |
| `UPSTREAM_TIMEOUT` | 504 | Pas de réponse à temps (`retryable: true`) | Dépôt et retrait : renvoyer avec **la même** `Idempotency-Key` |

---

## 6. Tableau récapitulatif des 38 endpoints

| # | Méthode | Chemin | Fonction | Rôles |
|---|---|---|---|---|
| 1 | POST | `/auth/login` | Se connecter (kiosque ou portail) | public |
| 2 | GET | `/accounts/{accountId}/balance` | Solde | connecté |
| 3 | GET | `/accounts/{accountId}/transactions` | Historique des opérations | connecté |
| 4 | POST | `/deposits` | Dépôt | connecté |
| 5 | POST | `/withdrawals` | Retrait | connecté |
| 6 | GET | `/kms/kiosks` | Lister les kiosques | A S Ad |
| 7 | POST | `/kms/kiosks` | Créer un kiosque | Ad |
| 8 | GET | `/kms/kiosks/{kioskId}` | Détail d'un kiosque | A S Ad |
| 9 | PATCH | `/kms/kiosks/{kioskId}` | Modifier un kiosque (statut…) | Ad |
| 10 | DELETE | `/kms/kiosks/{kioskId}` | Supprimer un kiosque | Ad |
| 11 | GET | `/kms/kiosks/{kioskId}/services` | Services du kiosque et disponibilité | connecté |
| 12 | PUT | `/kms/kiosks/{kioskId}/services/{serviceCode}` | Affecter ou activer un service | Ad |
| 13 | DELETE | `/kms/kiosks/{kioskId}/services/{serviceCode}` | Retirer un service du kiosque | Ad |
| 14 | GET | `/kms/kiosks/{kioskId}/devices` | Périphériques du kiosque | A S Ad |
| 15 | POST | `/kms/kiosks/{kioskId}/devices` | Installer un périphérique | Ad |
| 16 | GET | `/kms/kiosks/{kioskId}/devices/{deviceId}` | Détail d'un périphérique | A S Ad |
| 17 | PATCH | `/kms/kiosks/{kioskId}/devices/{deviceId}` | Modifier un périphérique (hors statut) | Ad |
| 18 | DELETE | `/kms/kiosks/{kioskId}/devices/{deviceId}` | Retirer un périphérique | Ad |
| 19 | PUT | `/kms/kiosks/{kioskId}/devices/{deviceId}/status` | Changer le statut | S Ad |
| 20 | GET | `/kms/kiosks/{kioskId}/devices/{deviceId}/status-history` | Historique d'un périphérique | A S Ad |
| 21 | GET | `/kms/kiosks/{kioskId}/status-history` | Historique du kiosque | A S Ad |
| 22 | GET | `/kms/device-types` | Catalogue des types | A S Ad |
| 23 | POST | `/kms/device-types` | Ajouter un type | Ad |
| 24 | GET | `/kms/device-types/{deviceTypeCode}` | Détail d'un type | A S Ad |
| 25 | PATCH | `/kms/device-types/{deviceTypeCode}` | Modifier un type | Ad |
| 26 | DELETE | `/kms/device-types/{deviceTypeCode}` | Supprimer un type | Ad |
| 27 | GET | `/kms/services` | Lister les services | A S Ad |
| 28 | POST | `/kms/services` | Créer un service | Ad |
| 29 | GET | `/kms/services/{serviceCode}` | Détail d'un service | A S Ad |
| 30 | PATCH | `/kms/services/{serviceCode}` | Modifier ou désactiver un service | Ad |
| 31 | DELETE | `/kms/services/{serviceCode}` | Supprimer un service | Ad |
| 32 | GET | `/kms/services/{serviceCode}/device-requirements` | Exigences d'un service | A S Ad |
| 33 | PUT | `/kms/services/{serviceCode}/device-requirements/{deviceTypeCode}` | Lier un type, avec un niveau | Ad |
| 34 | DELETE | `/kms/services/{serviceCode}/device-requirements/{deviceTypeCode}` | Délier un type | Ad |
| 35 | GET | `/kms/deposit-settings` | Paramètres du dépôt | connecté |
| 36 | PUT | `/kms/deposit-settings` | Modifier les paramètres du dépôt | Ad |
| 37 | GET | `/kms/withdrawal-settings` | Paramètres du retrait | connecté |
| 38 | PUT | `/kms/withdrawal-settings` | Modifier les paramètres du retrait | Ad |

Rôles : **A** = AGENT, **S** = SUPERVISOR, **Ad** = ADMIN, **connecté** = tout utilisateur authentifié (y compris CUSTOMER).
