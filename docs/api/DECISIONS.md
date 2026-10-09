# Contrat API MVP : décisions, questions ouvertes, risques

Story 3.2 : API simulée et contrat OpenAPI. Responsable : Si Abdelkbir.
Statut : **BROUILLON**, gel prévu le **lundi 12 octobre**.

## Appels couverts

| Appel | Utilisé par | operationId |
|---|---|---|
| `POST /auth/login` (kiosque : carte + PIN ; portail : identifiant + mot de passe) | Kiosque, portail | `login` |
| `GET /accounts/{accountId}/balance` | Kiosque | `getBalance` |
| `GET /accounts/{accountId}/transactions` (pagination par curseur) | Kiosque | `listTransactions` |
| `POST /deposits` | Kiosque | `createDeposit` |
| `GET /terminals` (filtre `status`) | Portail | `listTerminals` |
| `GET /terminals/{terminalId}` (disponibilité de chaque service) | Portail, mode dégradé | `getTerminal` |

## Décisions

| # | Décision | Raison |
|---|---|---|
| D-1 | OpenAPI **3.1**, un seul fichier `openapi/openapi.yaml` | Les schémas sont du JSON Schema standard, directement validables (ajv) |
| D-2 | Préfixe `/api/v1` | Permet de faire évoluer la version de l'API sans casser les clients existants |
| D-3 | En-tête `X-Correlation-Id` (UUID) **obligatoire** sur chaque requête, renvoyé dans chaque réponse et chaque erreur | Traçabilité de bout en bout. Une requête sans cet en-tête reçoit une erreur 400 |
| D-4 | Un **format d'erreur unique** `Error {code, message, correlationId, retryable?, details?}` | L'interface réagit selon `code` et `retryable`. `message` est technique et ne doit pas être affiché tel quel |
| D-5 | Statuts : 400 requête invalide, 401 non authentifié, 403 rôle insuffisant, 404 introuvable, 422 refus métier, 503 système aval indisponible, 504 délai aval dépassé | Chaque scénario d'erreur correspond à un statut distinct |
| D-6 | En-tête `Idempotency-Key` obligatoire sur `POST /deposits` | Un renvoi après un délai dépassé ne doit pas déposer deux fois |
| D-7 | Montants au format `Money {amount, currency}`, devise ISO 4217 (MAD) | Le format est explicite et prêt pour d'autres devises |
| D-8 | MSW comme mock principal, Prism en complément | MSW permet les scénarios pilotables et un état en mémoire, dans le navigateur comme dans les tests. Prism sert au partage avec curl, Postman ou le back-end |
| D-9 | Types et client générés (`openapi-typescript` + `openapi-fetch`). La CI vérifie que les types générés correspondent au contrat | Un écart avec le contrat provoque une erreur de compilation |

## Questions ouvertes

| # | Question | Responsable | Échéance |
|---|---|---|---|
| OQ-1 | Aligner `TransactionEnvelope` sur l'enveloppe générique de l'Epic 1 et sur le contrat du Routeur | Si Abdelkbir avec les responsables de l'Epic 1 et du Routeur | Lun. 12 oct. |
| OQ-2 | Authentification kiosque : le PIN est-il vérifié par l'Agent ou par le CBS ? Le format de la carte est-il PAN ou token ? | À définir | Lun. 12 oct. |
| OQ-3 | Durée de session (15 min dans le mock) et existence d'un refresh token | À définir | Lun. 12 oct. |
| OQ-4 | Codes d'erreur métier définitifs : liste fournie par le CBS ou le Routeur | À définir | Lun. 12 oct. |
| OQ-5 | Mode dégradé (Badr, 3.7) : `TerminalDetail.services` suffit-il, ou faut-il un endpoint de santé appelé par le kiosque lui-même ? | Badr, Si Abdelkbir | Lun. 12 oct. |
| OQ-6 | Liste définitive des rôles du portail (Anis, 3.8) : `AGENT`, `SUPERVISOR` et `ADMIN` sont provisoires | Anis | Lun. 12 oct. |

## Risques

| Risque | Mesure |
|---|---|
| Le back-end implémente un comportement différent du mock | Le contrat fait référence, et les tests de contrat pourront être rejoués contre le vrai back-end |
| Le contrat évolue après le gel et bloque le kiosque ou le portail | Toute évolution passe par une demande de changement (ci-dessous) |
| Des données sensibles apparaissent dans les fixtures | Les fixtures ne contiennent que des données fictives |

## Demande de changement (après le gel)

1. Ouvrir une issue intitulée `[API change] …` : motif, appel concerné, changement proposé (diff du YAML), changement compatible ou non.
2. Faire valider par les responsables concernés (kiosque, portail, back-end).
3. Ouvrir une PR qui modifie le contrat, les types générés, les handlers et les tests ensemble.
