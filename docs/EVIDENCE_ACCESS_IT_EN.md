# Consultare le prove senza il permesso di creare valutazioni / Reading evidence without assessment write authority

## Italiano

Prima, per cercare e scaricare una ricevuta bisognava condividere il token
Oracle. Lo stesso segreto permette di eseguire `POST /v1/assessments/run`,
salvare un risultato e valutarlo con TerraLex. Questa autorità è eccessiva per
chi deve soltanto controllare le prove.

Esempio: un gruppo locale conosce l'ID di una valutazione dell'ossigeno. Con il
nuovo token lettore può trovare gli ID delle ricevute, scaricare il pacchetto
originale e verificarlo offline con un registro di chiavi ottenuto separatamente.
Se prova ad avviare una valutazione o registrare un sensore, riceve 401 prima
dell'accesso ai dati di quelle operazioni. Il pacchetto resta identico: valori,
unità, firme, chiavi pubbliche acquisite e identificativi non sono riscritti.

| Operazione | Credenziale accettata |
| --- | --- |
| GET catalogo ricevute per assessment | Oracle in `x-oracle-token` oppure lettore in `x-evidence-token` |
| GET ricevuta esatta | Oracle in `x-oracle-token` oppure lettore in `x-evidence-token` |
| POST valutazione | solo Oracle in `x-oracle-token` |
| POST registrazione sensore | solo amministratore in `x-admin-token` |
| POST osservazione | firma del sensore, con le verifiche già esistenti |

Il lettore è facoltativo. `EVIDENCE_READ_API_TOKEN` assente o esattamente vuoto
nell'ambiente lo disabilita, senza segreto predefinito. Un valore attivo deve
contenere 32–256 caratteri ASCII visibili, senza spazi o controlli, ed essere
diverso dai token amministratore e Oracle. La lunghezza non dimostra casualità:
usare un generatore crittografico. `buildApp` rifiuta un token esplicitamente
vuoto; il server converte il valore vuoto dell'ambiente in ruolo disabilitato.
La configurazione attiva non valida blocca l'avvio prima della creazione del
pool, con un messaggio statico che non contiene segreti. Non si eliminano spazi
silenziosamente e non si cambiano le credenziali legacy.

Sui due GET basta uno dei due header corretti; se l'altro è errato non annulla
il permesso valido. Un token nel nome header sbagliato non trasferisce diritti.
L'autenticazione precede validazione dei parametri e accesso allo store; errori
e risposte dei GET mantengono `Cache-Control: no-store`. Gli errori restano
compatibili: 401 senza permesso, 400 per parametri invalidi dopo autenticazione,
404 per ricevuta assente e 500 generico per guasto o incoerenza archiviata.
Un catalogo sconosciuto resta 200 con lista vuota.

La modifica non aggiunge identità individuali, permessi per territorio, registro
degli accessi, limiti di traffico o firma dell'Oracle. È un segreto condiviso:
chi lo possiede può leggere tutte le ricevute esposte da quell'istanza. La sola
lettura è un permesso HTTP; il processo conserva il proprio ruolo database.
Occorrono trasporto protetto, custodia del segreto e riavvio per revoca/rotazione.
`latest` e gli endpoint di salute restano pubblici come nel prototipo attuale.

Non cambia la completezza del catalogo, la fiducia nelle chiavi o la verità
fisica delle misure. La verifica offline continua a richiedere chiavi fidate
separate. Nessuna migrazione, nuova osservazione ambientale, modifica numerica,
promozione delle previsioni, azione fisica o movimento di fondi. L'obiettivo
resta rendere le prove controllabili dalle comunità con permessi adeguati.

## English

Previously, receipt discovery and download required sharing the Oracle token.
The same secret can run an assessment, retain a new result and evaluate a
TerraLex policy. This grants excessive authority to a reviewer who only needs
to inspect evidence. The optional reader token separates those activities.

A local group can use a known assessment ID to discover receipts, download the
exact original packet and verify it offline against separately obtained trusted
keys. The reader receives 401 when attempting assessment execution or sensor
registration, before those operations access storage. Original signed values,
units, signatures, captured public-key bindings and IDs remain unchanged.

Both receipt GET routes accept a valid Oracle credential in `x-oracle-token`
OR a configured reader credential in `x-evidence-token`. Either valid header
is sufficient even if the other is wrong. Assessment POST still requires the
Oracle credential; sensor registration still requires the administrator.
Signed observation submission retains its existing signature checks. Putting
reader bytes in a writer/admin header grants no write permission.

Unset or exactly empty `EVIDENCE_READ_API_TOKEN` disables this role, without a
fallback secret. An active value must be 32–256 visible ASCII characters with
no whitespace/control characters, distinct from both other credentials. Format
validation does not establish entropy; use a cryptographic random generator.
The direct `buildApp` interface rejects an explicitly empty configured token;
the server maps an empty environment variable to a disabled role. Invalid
active configuration fails before store construction, with a static error that
contains no secret. Values are never silently trimmed or substituted.

Authentication remains before path/query validation and storage. The GET routes
retain no-store on success/errors, legacy 401 errors, authenticated 400 invalid
input, 404 missing packet, 200 empty unknown catalog and generic 500 failures.
Oracle read compatibility remains intact. Configure the process environment
directly for local pnpm; Compose consumes its private `.env`. Token rotation or
revocation takes a configuration update and restart, with no database migration.

This is one shared, instance-wide HTTP read credential, without individual
identity, region scoping, access audit, traffic limits or Oracle issuer signing.
It does not change the process's database role. Keep credentials out of URLs,
logs and source control and use protected transport. The prototype's health and
latest-assessment endpoints remain public. Legacy development secrets remain
development-only; this feature does not configure HTTPS or deploy the service.

Catalog completeness and physical truth are still unproven; offline verification
still requires separate trusted keys. No new environmental data, training,
numerical change, operational forecast promotion, treasury movement or physical
action is included. The change supports community scrutiny through appropriate
permissions, within the original Virdacora mission.

## Verification / Verifica

The pre-change baseline is recorded in
[`evidence/evidence-access/baseline-results.json`](evidence/evidence-access/baseline-results.json):
both configured reader GET requests returned 401 instead of the intended 200.
The test file's source fingerprint and reported test timing are retained there.

Tests cover permission boundaries, malformed/misplaced credentials, legacy
compatibility, unchanged signed packets and external-key offline replay.
PostgreSQL cases cover reopening app/pool and reads through a read-only DB
session, plus denied writes on a writable DB with unchanged table snapshots.
The existing Linux signal runner now supplies an ephemeral reader credential to
the compiled server and checks read access/write denial before each signal case.
Test credentials and data are synthetic. The local verification receipt records
which checks actually ran; database and Linux-container results require CI.
Same-family Codex review is software review, not independent environmental
validation. See the PR's CI links for execution results on its exact revision.
