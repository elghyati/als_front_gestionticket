# Schémas des enchaînements des endpoints – API ALS (MVP)

Ce document complète le [guide des endpoints](ENDPOINTS.md) avec des schémas. Ils sont écrits en **Mermaid** : GitHub et VS Code les affichent automatiquement (dans VS Code, l'aperçu *Ctrl + Shift + V* nécessite l'extension « Markdown Preview Mermaid Support »).

Dans les schémas, « API » désigne le back-end vu par le front : Agent, Routeur et KMS. Le mock MSW joue ce rôle aujourd'hui.

## Sommaire

1. [Vue d'ensemble : qui appelle quoi](#1-vue-densemble--qui-appelle-quoi)
2. [Kiosque : démarrage et menu](#2-kiosque--démarrage-et-menu)
3. [Kiosque : retrait](#3-kiosque--retrait)
4. [Kiosque : dépôt](#4-kiosque--dépôt)
5. [Contrôles d'un dépôt ou d'un retrait](#5-contrôles-dun-dépôt-ou-dun-retrait)
6. [Portail : traitement d'un incident](#6-portail--traitement-dun-incident)
7. [Portail : mise en service d'un kiosque](#7-portail--mise-en-service-dun-kiosque)
8. [Portail : création d'un service](#8-portail--création-dun-service)
9. [Calcul de la disponibilité d'un service](#9-calcul-de-la-disponibilité-dun-service)
10. [Ce qui recalcule la disponibilité](#10-ce-qui-recalcule-la-disponibilité)
11. [Cycle de vie d'un kiosque](#11-cycle-de-vie-dun-kiosque)
12. [Modèle de données du KMS](#12-modèle-de-données-du-kms)

---

## 1. Vue d'ensemble : qui appelle quoi

```mermaid
flowchart TB
    subgraph K["🏧 Application kiosque — rôle CUSTOMER"]
        direction LR
        K1[Démarrage du kiosque]
        K2[Session client]
    end
    subgraph P["🖥️ Portail — AGENT · SUPERVISOR · ADMIN"]
        direction LR
        P1[Supervision]
        P2[Paramétrage]
    end

    subgraph BANK["API bancaire"]
        AUTH["POST /auth/login"]
        ACC["GET /accounts/{id}/balance<br/>GET /accounts/{id}/transactions"]
        TX["POST /deposits<br/>POST /withdrawals"]
    end
    subgraph KMS["API KMS — /kms"]
        KSVC["GET /kiosks/{id}/services<br/>(disponibilité calculée)"]
        SET["/deposit-settings<br/>/withdrawal-settings"]
        KIO["/kiosks (CRUD)<br/>/kiosks/{id}/services (affectation)"]
        DEV["/kiosks/{id}/devices (CRUD)<br/>…/status · …/status-history"]
        CAT["/device-types (CRUD)<br/>/services (CRUD)<br/>/services/{code}/device-requirements"]
    end

    K1 --> KSVC & SET
    K2 --> AUTH & ACC & TX
    P1 --> AUTH & KIO & DEV & KSVC
    P2 --> KIO & CAT & SET

    TX -. "vérifie la disponibilité" .-> KSVC
    TX -. "applique les règles" .-> SET
    DEV -. "recalcule" .-> KSVC
    CAT -. "recalcule" .-> KSVC
```

---

## 2. Kiosque : démarrage et menu

Le kiosque charge son menu et ses paramètres **avant** l'arrivée d'un client, puis il les rafraîchit régulièrement : la disponibilité change quand un périphérique tombe en panne.

```mermaid
sequenceDiagram
    autonumber
    participant K as Application kiosque
    participant API as API

    Note over K: Démarrage, ou rafraîchissement périodique
    K->>API: GET /kms/kiosks/KIOSK-01/services
    API-->>K: 200 items[] : availability + issues par service
    K->>API: GET /kms/deposit-settings
    API-->>K: 200 billets acceptés, min, max, plafond
    K->>API: GET /kms/withdrawal-settings
    API-->>K: 200 montants rapides, multiple, min, max

    Note over K: Construction du menu
    alt availability = AVAILABLE
        K->>K: afficher le service
    else availability = DEGRADED
        K->>K: afficher avec un avertissement (ex. « pas de ticket »)
    else availability = UNAVAILABLE
        K->>K: masquer ou griser le service
    end

    opt 503 KMS_UNAVAILABLE
        K->>K: garder le dernier menu connu, réessayer plus tard
    end
```

---

## 3. Kiosque : retrait

```mermaid
sequenceDiagram
    autonumber
    actor C as Client
    participant K as Application kiosque
    participant API as API

    C->>K: insère sa carte, tape son PIN
    K->>API: POST /auth/login {channel: KIOSK, cardNumber, pin, kioskId}
    alt PIN correct
        API-->>K: 200 accessToken, accountIds
    else PIN faux
        API-->>K: 401 INVALID_CREDENTIALS
        K-->>C: « Code incorrect »
    end

    opt Le client consulte son solde
        K->>API: GET /accounts/ACC-001/balance
        API-->>K: 200 available, ledger
    end

    C->>K: choisit « Retrait », puis 700 MAD
    K->>K: génère Idempotency-Key = K1
    K->>API: POST /withdrawals {accountId, kioskId, amount: 700} + Idempotency-Key K1
    alt Accepté
        API-->>K: 201 cashBreakdown [3×200, 1×100]
        K-->>C: distribue les billets (+ ticket si l'imprimante est disponible)
    else Refus métier
        API-->>K: 422 code (INSUFFICIENT_FUNDS, AMOUNT_NOT_MULTIPLE…)
        K-->>C: message selon le code
    else Délai dépassé
        API-->>K: 504 UPSTREAM_TIMEOUT (retryable)
        K->>API: POST /withdrawals … + MÊME Idempotency-Key K1
        API-->>K: 201 la même opération (jamais deux retraits)
    end
```

---

## 4. Kiosque : dépôt

```mermaid
sequenceDiagram
    autonumber
    actor C as Client
    participant K as Application kiosque
    participant A as Accepteur de billets
    participant API as API

    Note over C,API: Client déjà connecté (voir le retrait, étapes 1 à 3)
    C->>K: choisit « Dépôt »
    C->>A: insère les billets
    A-->>K: billets comptés : 2 × 100
    K->>K: génère Idempotency-Key = K2
    K->>API: POST /deposits {accountId, kioskId, amount: 200, notes: [100×2]} + K2
    alt Accepté
        API-->>K: 201 type DEPOSIT, status ACCEPTED
        K-->>C: « Dépôt effectué »
    else Billet refusé, trop de billets, plafond…
        API-->>K: 422 DENOMINATION_NOT_ACCEPTED / TOO_MANY_NOTES / DAILY_LIMIT_EXCEEDED
        K->>A: restitue les billets
        K-->>C: message selon le code
    else Service devenu indisponible entre-temps
        API-->>K: 422 SERVICE_UNAVAILABLE_ON_KIOSK
        K->>A: restitue les billets
        K->>API: GET /kms/kiosks/KIOSK-01/services (rafraîchit le menu)
    end
```

---

## 5. Contrôles d'un dépôt ou d'un retrait

Ordre des contrôles appliqués par `POST /deposits` et `POST /withdrawals` :

```mermaid
flowchart TD
    S([Requête reçue]) --> H{En-têtes<br/>X-Correlation-Id et<br/>Idempotency-Key ?}
    H -- non --> E400a[400 MISSING_…]
    H -- oui --> AUTH{Token valide ?}
    AUTH -- non --> E401[401 UNAUTHORIZED]
    AUTH -- oui --> IDEM{Clé déjà utilisée<br/>pour cette opération ?}
    IDEM -- oui --> R201b[201 : renvoie l'opération d'origine<br/>sans rien refaire]
    IDEM -- non --> BODY{Corps valide ?<br/>montant > 0, devise,<br/>kiosque, compte}
    BODY -- non --> E400b[400 INVALID_DEPOSIT / INVALID_WITHDRAWAL<br/>+ details]
    BODY -- oui --> SVC{Service affecté au kiosque<br/>et non UNAVAILABLE ?}
    SVC -- non --> E422a[422 SERVICE_UNAVAILABLE_ON_KIOSK]
    SVC -- oui --> LIM{min ≤ montant ≤ max<br/>et total du jour ≤ plafond ?}
    LIM -- non --> E422b[422 AMOUNT_BELOW_MINIMUM<br/>AMOUNT_ABOVE_MAXIMUM<br/>DAILY_LIMIT_EXCEEDED]
    LIM -- oui --> TYPE{Type d'opération}

    TYPE -- dépôt --> DN{Billets fournis ?}
    DN -- non --> OK
    DN -- oui --> DN2{Total = montant ?<br/>coupures acceptées ?<br/>nombre ≤ max ?}
    DN2 -- non --> E422c[400 si total ≠ montant<br/>422 DENOMINATION_NOT_ACCEPTED<br/>422 TOO_MANY_NOTES]
    DN2 -- oui --> OK

    TYPE -- retrait --> WM{Multiple de 100 ?<br/>composable avec les billets chargés ?<br/>nombre de billets ≤ max ?}
    WM -- non --> E422d[422 AMOUNT_NOT_MULTIPLE<br/>AMOUNT_NOT_DISPENSABLE<br/>TOO_MANY_NOTES]
    WM -- oui --> FUNDS{Solde disponible<br/>suffisant ?}
    FUNDS -- non --> E422e[422 INSUFFICIENT_FUNDS]
    FUNDS -- oui --> OK

    OK[Solde mis à jour<br/>opération ajoutée à l'historique] --> R201([201 TransactionEnvelope])

    classDef err fill:#fde2e1,stroke:#c0392b,color:#000
    classDef ok fill:#e3f6e5,stroke:#2e7d32,color:#000
    class E400a,E400b,E401,E422a,E422b,E422c,E422d,E422e err
    class R201,R201b,OK ok
```

---

## 6. Portail : traitement d'un incident

```mermaid
sequenceDiagram
    autonumber
    actor S as Superviseur
    participant P as Portail
    participant API as API

    S->>P: se connecte
    P->>API: POST /auth/login {channel: PORTAL, username, password}
    API-->>P: 200 accessToken, roles [SUPERVISOR]

    P->>API: GET /kms/kiosks?health=DEGRADED
    API-->>P: 200 [KIOSK-02 : DEGRADED]
    S->>P: ouvre KIOSK-02

    par Détail du kiosque
        P->>API: GET /kms/kiosks/KIOSK-02/services
        API-->>P: DEPOSIT UNAVAILABLE (CASH_ACCEPTOR MANDATORY)<br/>WITHDRAWAL DEGRADED (RECEIPT_PRINTER RECOMMENDED)
    and
        P->>API: GET /kms/kiosks/KIOSK-02/devices?status=ERROR
        API-->>P: DEV-0204 accepteur (JAM), DEV-0206 imprimante (OUT_OF_PAPER)
    end

    S->>P: ouvre l'historique de DEV-0204
    P->>API: GET /kms/kiosks/KIOSK-02/devices/DEV-0204/status-history
    API-->>P: OPERATIONAL → WARNING (NEAR_FULL) → ERROR (JAM)

    Note over S: Intervention sur place : bourrage retiré
    S->>P: déclare la réparation
    P->>API: PUT /kms/kiosks/KIOSK-02/devices/DEV-0204/status {status: OPERATIONAL, reason}
    API->>API: enregistre l'historique (ERROR → OPERATIONAL, changedBy)<br/>recalcule services et santé
    API-->>P: 200 périphérique OPERATIONAL

    P->>API: GET /kms/kiosks/KIOSK-02/services
    API-->>P: DEPOSIT AVAILABLE ✅
```

---

## 7. Portail : mise en service d'un kiosque

```mermaid
sequenceDiagram
    autonumber
    actor A as Administrateur
    participant P as Portail
    participant API as API

    A->>P: « Nouveau kiosque »
    P->>API: POST /kms/kiosks {kioskId: KIOSK-10, name, location}
    API-->>P: 201 status MAINTENANCE, health OUT_OF_SERVICE

    loop Pour chaque périphérique installé
        P->>API: POST /kms/kiosks/KIOSK-10/devices {deviceTypeCode, serialNumber, …}
        API-->>P: 201 deviceId (statut initial enregistré dans l'historique)
    end

    loop Pour chaque service proposé
        P->>API: PUT /kms/kiosks/KIOSK-10/services/DEPOSIT {enabled: true}
        API-->>P: 200 availability + issues
    end

    P->>API: GET /kms/kiosks/KIOSK-10/services
    API-->>P: services UNAVAILABLE : KIOSK_NOT_ONLINE (normal en MAINTENANCE)
    Note over A,P: Vérifier qu'il ne reste pas de DEVICE_MISSING

    A->>P: « Mettre en service »
    P->>API: PATCH /kms/kiosks/KIOSK-10 {status: ONLINE}
    API-->>P: 200 health HEALTHY
```

---

## 8. Portail : création d'un service

```mermaid
sequenceDiagram
    autonumber
    actor A as Administrateur
    participant P as Portail
    participant API as API

    opt Nouveau type de périphérique nécessaire
        P->>API: POST /kms/device-types {deviceTypeCode: BARCODE_SCANNER, name, category: INPUT}
        API-->>P: 201
    end

    P->>API: POST /kms/services {serviceCode: BILL_PAYMENT, name}
    API-->>P: 201 builtIn false, deviceRequirements []

    P->>API: PUT /kms/services/BILL_PAYMENT/device-requirements/CARD_READER {requirement: MANDATORY}
    P->>API: PUT /kms/services/BILL_PAYMENT/device-requirements/BARCODE_SCANNER {requirement: MANDATORY}
    P->>API: PUT /kms/services/BILL_PAYMENT/device-requirements/RECEIPT_PRINTER {requirement: RECOMMENDED}
    API-->>P: 200 (pour chaque lien)

    P->>API: PUT /kms/kiosks/KIOSK-01/services/BILL_PAYMENT {enabled: true}
    API-->>P: 200 UNAVAILABLE, issue DEVICE_MISSING BARCODE_SCANNER
    P->>API: POST /kms/kiosks/KIOSK-01/devices {deviceTypeCode: BARCODE_SCANNER, …}
    API-->>P: 201
    P->>API: GET /kms/kiosks/KIOSK-01/services
    API-->>P: BILL_PAYMENT AVAILABLE ✅

    Note over A,API: Suppression plus tard : DELETE /kms/services/BILL_PAYMENT<br/>→ 409 SERVICE_ASSIGNED tant qu'il est affecté à un kiosque
```

---

## 9. Calcul de la disponibilité d'un service

Ce calcul est fait par l'API pour chaque service affecté à un kiosque, à chaque lecture de `GET /kms/kiosks/{id}/services`.

```mermaid
flowchart TD
    S([Service affecté au kiosque]) --> G{Service activé<br/>globalement ?}
    G -- non --> U1[UNAVAILABLE<br/>SERVICE_DISABLED]
    G -- oui --> L{Activé sur<br/>ce kiosque ?}
    L -- non --> U2[UNAVAILABLE<br/>SERVICE_DISABLED_ON_KIOSK]
    L -- oui --> O{Kiosque<br/>ONLINE ?}
    O -- non --> U3[UNAVAILABLE<br/>KIOSK_NOT_ONLINE]
    O -- oui --> R[Pour chaque type de périphérique exigé :<br/>le kiosque en a-t-il un utilisable ?<br/>statut OPERATIONAL ou WARNING]
    R --> M{Un type MANDATORY<br/>sans périphérique utilisable ?}
    M -- oui --> U4[UNAVAILABLE<br/>DEVICE_MISSING / DEVICE_NOT_USABLE]
    M -- non --> RE{Un type RECOMMENDED<br/>sans périphérique utilisable ?}
    RE -- oui --> D[DEGRADED]
    RE -- non --> A[AVAILABLE<br/>issues : les types OPTIONAL manquants]

    classDef bad fill:#fde2e1,stroke:#c0392b,color:#000
    classDef mid fill:#fff4d6,stroke:#b9770e,color:#000
    classDef good fill:#e3f6e5,stroke:#2e7d32,color:#000
    class U1,U2,U3,U4 bad
    class D mid
    class A good
```

La santé du kiosque en découle :

```mermaid
flowchart LR
    K([Kiosque]) --> O{ONLINE ?}
    O -- non --> OOS[OUT_OF_SERVICE]
    O -- oui --> ALL{Tous ses services<br/>UNAVAILABLE ?}
    ALL -- oui --> OOS
    ALL -- non --> ANY{Un service non AVAILABLE<br/>ou un périphérique inutilisable ?}
    ANY -- oui --> DEG[DEGRADED]
    ANY -- non --> H[HEALTHY]

    classDef bad fill:#fde2e1,stroke:#c0392b,color:#000
    classDef mid fill:#fff4d6,stroke:#b9770e,color:#000
    classDef good fill:#e3f6e5,stroke:#2e7d32,color:#000
    class OOS bad
    class DEG mid
    class H good
```

---

## 10. Ce qui recalcule la disponibilité

Ces écritures modifient immédiatement ce que renvoient `GET /kms/kiosks/{id}/services`, ainsi que `health` dans `GET /kms/kiosks`. Elles décident donc de ce que le kiosque peut proposer et de ce que `POST /deposits` et `POST /withdrawals` acceptent.

```mermaid
flowchart LR
    subgraph W["Écritures (portail)"]
        W1["PUT …/devices/{id}/status"]
        W2["POST / DELETE …/devices"]
        W3["PATCH /kms/kiosks/{id}<br/>(status)"]
        W4["PUT / DELETE …/kiosks/{id}/services/{code}"]
        W5["PATCH /kms/services/{code}<br/>(enabled)"]
        W6["PUT / DELETE<br/>…/device-requirements/{type}"]
    end

    AV(("Disponibilité<br/>des services<br/>+ santé<br/>des kiosques"))

    subgraph R["Lectures et effets"]
        R1["GET /kms/kiosks/{id}/services<br/>→ menu du kiosque"]
        R2["GET /kms/kiosks?health=…<br/>→ tableau de bord"]
        R3["POST /deposits · POST /withdrawals<br/>→ 422 SERVICE_UNAVAILABLE_ON_KIOSK"]
    end

    W1 --> AV
    W2 --> AV
    W3 --> AV
    W4 --> AV
    W5 --> AV
    W6 --> AV
    AV --> R1
    AV --> R2
    AV --> R3

    W1 -. "ajoute une entrée" .-> H[("Historique<br/>des statuts")]
    W2 -. "statut initial" .-> H
```

---

## 11. Cycle de vie d'un kiosque

```mermaid
stateDiagram-v2
    [*] --> MAINTENANCE: POST /kms/kiosks
    MAINTENANCE --> ONLINE: PATCH status ONLINE
    ONLINE --> MAINTENANCE: PATCH status MAINTENANCE
    ONLINE --> OFFLINE: PATCH status OFFLINE<br/>(ou perte de connexion, voir OQ-9)
    OFFLINE --> ONLINE: PATCH status ONLINE
    OFFLINE --> MAINTENANCE: PATCH status MAINTENANCE
    MAINTENANCE --> [*]: DELETE (204)
    OFFLINE --> [*]: DELETE (204)
    note right of ONLINE
        DELETE refusé :
        409 KIOSK_ONLINE
    end note
```

Cycle d'un périphérique : chaque flèche est un appel `PUT …/status`, qui laisse une trace dans l'historique.

```mermaid
flowchart LR
    NEW(["POST …/devices<br/>(OPERATIONAL par défaut)"]) --> OP

    subgraph U["✅ Utilisables"]
        OP[OPERATIONAL]
        WA["WARNING<br/>PAPER_LOW, NEAR_FULL…"]
    end
    subgraph N["❌ Inutilisables"]
        ER["ERROR<br/>JAM, OUT_OF_PAPER…"]
        OF["OFFLINE<br/>NOT_RESPONDING"]
        MA[MAINTENANCE]
        DI[DISABLED]
    end

    OP -- alerte --> WA
    WA -- alerte levée --> OP
    U -- "panne · ne répond plus ·<br/>intervention · désactivation" --> N
    N -- "réparation · reconnexion ·<br/>fin d'intervention · réactivation" --> U
    U -.-> DEL(["DELETE …/devices/{id}<br/>historique conservé"])
    N -.-> DEL

    classDef good fill:#e3f6e5,stroke:#2e7d32,color:#000
    classDef bad fill:#fde2e1,stroke:#c0392b,color:#000
    class OP,WA good
    class ER,OF,MA,DI bad
```

En réalité, toute transition entre deux statuts est permise ; le schéma montre les cas usuels. Seuls `OPERATIONAL` et `WARNING` comptent comme utilisables.

---

## 12. Modèle de données du KMS

```mermaid
erDiagram
    KIOSK ||--o{ KIOSK_DEVICE : "a installé"
    KIOSK ||--o{ KIOSK_SERVICE : "propose"
    KIOSK ||--o{ DEVICE_STATUS_CHANGE : "historique"
    DEVICE_TYPE ||--o{ KIOSK_DEVICE : "type de"
    DEVICE_TYPE ||--o{ SERVICE_DEVICE_REQUIREMENT : "exigé par"
    SERVICE ||--o{ SERVICE_DEVICE_REQUIREMENT : "exige"
    SERVICE ||--o{ KIOSK_SERVICE : "affecté via"
    KIOSK_DEVICE ||--o{ DEVICE_STATUS_CHANGE : "change de statut"

    KIOSK {
        string kioskId PK
        string name
        object location
        enum status "ONLINE | OFFLINE | MAINTENANCE"
        enum health "calculé"
        int deviceCount "calculé"
    }
    KIOSK_DEVICE {
        string deviceId PK
        string kioskId FK
        string deviceTypeCode FK
        string serialNumber
        enum status "OPERATIONAL … DISABLED"
        string statusReasonCode
    }
    DEVICE_TYPE {
        string deviceTypeCode PK
        string name
        enum category "CASH | CARD | PRINTER …"
    }
    SERVICE {
        string serviceCode PK
        string name
        bool enabled "switch global"
        bool builtIn "non supprimable"
    }
    SERVICE_DEVICE_REQUIREMENT {
        string serviceCode FK
        string deviceTypeCode FK
        enum requirement "MANDATORY | RECOMMENDED | OPTIONAL"
    }
    KIOSK_SERVICE {
        string kioskId FK
        string serviceCode FK
        bool enabled "switch local"
        enum availability "calculé"
    }
    DEVICE_STATUS_CHANGE {
        string changeId PK
        string kioskId
        string deviceId
        enum previousStatus
        enum newStatus
        string reasonCode
        enum source "DEVICE | OPERATOR | SYSTEM"
        string changedBy
        datetime changedAt
    }
```

Les paramètres de dépôt et de retrait (`/kms/deposit-settings`, `/kms/withdrawal-settings`) sont deux objets globaux, sans lien avec un kiosque particulier (voir OQ-7 dans `DECISIONS.md`).
