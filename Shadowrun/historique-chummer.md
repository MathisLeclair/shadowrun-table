# Historique Chummer → Foundry → app

Comparaison des anciens fichiers Chummer (`Shadowrun_chum5_files`) avec les fiches **en jeu** (état de la table Lazarus exporté du VPS le 26/11/2026, issu de Foundry).
Les fichiers Chummer sont **anciens** : ils donnent un point de repère historique, pas l'état actuel. Une différence n'est donc pas forcément une perte : le personnage a pu vendre, consommer ou remplacer l'objet en jeu.

Méthode : lecture des `.chum5` avec le lecteur Chummer de l'app (`server/lib/chummer/parse.js`), puis rapprochement objet par objet (id catalogue, puis nom FR/EN). Les sous-éléments intégrés (fonctions de commlink, kit de survie, options de lunettes…) et les objets qui ont seulement changé de liste (grenades passées en armes, commlink passé en appareil Matrix, vêtements passés de l'armure à l'équipement) sont ignorés.

## Vue d'ensemble

| PJ | Fichier | Date | Chummer | Mode | Karma dispo / total : alors → maintenant | Nuyens : alors → maintenant |
|---|---|---|---|---|---|---|
| Jane | Jane_Active.chum5 | 01/08/2020 | 5.212 | carrière | 13 / 49 → 22 / 83 | 89 740 ¥ → 98 188 ¥ |
| Bricks | Bricks.chum5 | 26/01/2021 | 5.212 | **création** | 0 / 0 → 20 / 20 | 1 328 ¥ → 16 494 ¥ |
| Bricks | Bricks_active.chum5 (le plus récent) | 07/07/2026 | 5.226 | carrière | 0 / 0 → 20 / 20 | 3 128 ¥ → 16 494 ¥ |
| Ank'Lay (retiré) | Ank_Lay_Active.chum5 | 09/05/2020 | 5.210 | carrière | 13 / 23 → 16 / 26 | 46 079 ¥ → 46 079 ¥ |
| Christopher (retiré) | Christopher_Armingstar_Active.chum5 | 01/08/2020 | 5.212 | carrière | 16 / 56 → 5 / 69 | 87 857 ¥ → 207 159 ¥ |
| Anthony | aucun fichier | — | — | — | 27 / 27 (Foundry) | 31 757 ¥ |

Karma et nuyens : à titre indicatif seulement, rien n'a été modifié.

Livres utilisés dans les fichiers (objets par livre) : Jane SR5, RG 15, RF 13, CA 8, SG 4, R5 3, SSP 2, CF 2 ; Ank'Lay SR5, RG 27, RF 23, CF 8, DT 2, CA 2, BTB 2 ; Christopher SR5, R5 20, RF 10, RG 8, CA 5, GH3 2 ; Bricks SR5, DT 12, KC 9, SL 3, RF 3, BTB 2 (son fichier 2026 active presque tous les livres). Le catalogue de l'app couvre tous ces livres (détail dans `app/data/catalog/coverage.md`).

## Trains de vie : alors / maintenant

Les options de train de vie (DocWagon, Ultra-sécurisé, garage…) ont été perdues lors du passage Chummer → Foundry : Foundry ne gardait que le nom et le coût total. **Elles sont restaurées** (voir « À restaurer »). Chaque option restaurée porte la note « Restauré depuis Chummer (fichier du …) — à vérifier ».

| PJ | Chummer | En jeu avant restauration | Après restauration |
|---|---|---|---|
| Jane | « Best Home », Moyen 5 000 ¥ + Contrat DocWagon (Or) 2 083 ¥ + Ultra-sécurisé (+20 %) + Service d'analyse de phéromones 250 ¥ + Détecteur de mensonges en ligne 250 ¥ = **8 583 ¥/mois** | « Best Home (Moyen) » 5 000 ¥, aucune option | 8 583 ¥/mois, les 4 options |
| Bricks | « Seattle Downtown Outskirts », Moyen + Contrat DocWagon (Or) = **7 083 ¥/mois** (identique en 2021 et 2026) | « Seattle Downtown Outskirts (Moyen) » 5 000 ¥ | 7 083 ¥/mois |
| Ank'Lay | « Home », Bas 2 000 ¥, aucune option (2 mois payés) | « Home (Bas) » 2 000 ¥ (1 mois payé) | inchangé (lié au catalogue « Low ») |
| Christopher | « The Hut », Moyen avec points RF (Confort 3, Sécurité 4, Voisinage 5) + Endroit dangereux (−20 %) + Contrat DocWagon (Or) 2 083 ¥ + Garage (gros véhicule, Body 5+) 100 ¥ + Pilier de bar (The Jeffrey's) 25 ¥ = **6 248 ¥/mois** | « The Lounge (Haut) » 10 000 ¥ | **conservé** (The Lounge, 10 000 ¥) ; l'ancien train de vie est seulement noté dans les notes du train de vie |
| Anthony | pas de fichier | « Anthony's lifestyle (Moyen) » **7 083 ¥** alors qu'un Moyen coûte 5 000 ¥ | interprété comme Moyen 5 000 ¥ + Contrat DocWagon (Or) 2 083 ¥ (loyer identique), note « Déduit du loyer Foundry… — à vérifier » |

## Jane (01/08/2020)

Accessoires et modifications perdus par la migration et **restaurés** (sans changer les indices d'armure, qui les comptaient déjà) :
- Defiance EX Shocker : holster rapide dissimulé ; Ares Desert Strike : amortisseur de recul et lunette de visée (intégrés) ; Enfield AS-7 : visée laser (intégrée).
- Costume « Actioneer » : vêtements électrochromes, poches de gel. Heritage 12 : protection chimique 6, YNT Softweave, mode RA, poches de gel, non-conductivité 3, électrochromes. Second Skin : protection anti-radiations 2.

| Élément Chummer | Aujourd'hui | Jugement |
|---|---|---|
| Revêtement polymère au ruthénium 4 (Second Skin), « Custom Fit » / « Newest Model » (RG) | absents | non restaurés (les deux derniers n'existent pas dans le catalogue) — à ajouter à la main si voulu |
| Signature Masking 4 sur l'Artemis Nightwing | Nightwing présent, sans modification | modification de véhicule perdue — à restaurer à la main |
| Custom Commlink : générateur de bruit blanc R6, scanner de signaux R6 | absents ; un « Brouilleur (Zone) » existe | probablement remplacé ? |
| Créditube certifié (Or) | Créditube certifié (Platine) | probablement remplacé |
| Grenades Neuro-Stun VIII (toxine) | grenades à gaz présentes comme armes | probablement consommées / toxine non précisée |

Ajouts depuis : SAAB Dynamit, contact Perrine Cabana (2/4), langues allemand, coréen, français ; CON 1→2, Chance 2→3, Serrurerie 1→2 ; armures Actioneer 8→10 et Heritage 12→14 (poches de gel comptées par Foundry).

## Bricks (07/07/2026, et création 26/01/2021)

Restauré : Beretta Northstar — chargeur supplémentaire et **smartgun interne** (intégrés).

| Élément Chummer | Aujourd'hui | Jugement |
|---|---|---|
| Yeux cybernétiques R4 avec **Smartlink** et Interface visuelle | yeux R4 seuls (Essence identique 5,35) | sous-systèmes perdus par la migration — **le smartgun du Northstar ne sert à rien sans le Smartlink** |
| Programmes Sneak, Exploit, Fly on a Wall (sur câble universel) ; porte-programmes Baby Monitor et Wrapper (DT) | absents de la liste de programmes | perdus ou remplacés ? à vérifier |
| Agent indice 5 | « Agent » indice 6 en équipement, « Agent (5) » dans les programmes | incohérence à trancher |
| Anglais (langue maternelle) | absent | perdu par la migration (sans effet en jeu) |

Ajouts depuis : Fichetti Security 600, Colt Cobra TZ-120, holster rapide dissimulé, contacts Perrine Cabana (2/4), Joseph Mayers (1/4), Jane (4/4). Les cybergrenades (KC) sont devenues les armes « Grenade: Douser » et « Grenade: COS ».

## Ank'Lay (09/05/2020, retiré)

Restauré : 13 modifications d'armure (Executive Suite : électrochromes, YNT Softweave, non-conductivité 3, intégration mana grise 3 ; manteau Argentum : électrochromes, YNT, collerette électrique, poches de gel, isolation 6, résistance au feu 6, auto-injecteur, protection chimique 5 ; Second Skin : anti-radiations 2).

| Élément Chummer | Aujourd'hui | Jugement |
|---|---|---|
| Compétence Flight 1 | absente | probablement un artefact Chummer (compétence de vol) — à ignorer ? |
| Knife (kit de survie) | « Couteau » | même objet |
| Revêtement polymère au ruthénium 4 (Second Skin) | absent | non restauré — à ajouter à la main si voulu |
| Anglais (langue maternelle) | absent | perdu par la migration |

Ajouts depuis : Colt Cobra TZ-120, Fancy Whiskey, contact Perrine Cabana (2/4). Rien d'autre de notable : fiche quasi identique (nuyens identiques).

## Christopher (01/08/2020, retiré)

Restauré : Colt Government 2066 (visée laser, silencieux), Ares Light Fire 75 (smartgun interne, holster dissimulable), couteau de combat (holster dissimulable) ; Heritage 12 (électrochromes, résistance au feu 2), manteau Greatcoat (électrochromes, collerette électrique).

| Élément Chummer | Aujourd'hui | Jugement |
|---|---|---|
| **Ares Roadmaster** (transport blindé, 18 modifications : blindage, Valkyrie, amenities hautes, pneus increvables…) | absent | perdu ou vendu ? (le Garage du train de vie « The Hut » servait à le garer) |
| Yeux cybernétiques R2 **delta** avec interface visuelle, thermographie, vision nocturne, anti-flash | yeux R2 « standard », sans sous-systèmes (Essence identique 5,65) | grade et sous-systèmes perdus par la migration |
| Silencieux (Ares Light Fire 75) | absent | non restauré |
| Langues maternelles japonais et anglais (Bilingue) | absentes | perdues par la migration |
| « The Hut » (Moyen, 6 248 ¥) | « The Lounge » (Haut, 10 000 ¥) | changement en jeu probable : conservé |

Ajouts depuis : Artillerie 1, FOR 2→3, contacts Erik « The Brick » Walker (4/1) et Charles Juno (1/1), menottes, corde, créditube Ébène.

## Anthony Von Schloss

Pas de fichier Chummer. Son train de vie Foundry coûte 7 083 ¥/mois alors qu'un Moyen coûte 5 000 ¥ : l'écart (2 083 ¥) correspond exactement à un **Contrat DocWagon (Or)**, que Jane, Bricks et Christopher avaient tous. L'app l'affiche ainsi (loyer inchangé), avec la note « à vérifier ».

## Autres fichiers (hors campagne actuelle)

Ava Hopkins (création + carrière, 2020), Eva Otoko (2020), Vi Moneaux / Veronica Simmons (2020, contact « Vi Moneau » de Christopher), Frizzy Fiona (2021, en création) : non comparés.

Aucun fichier ne contient d'art martial.

## À restaurer

- [x] Trains de vie de Jane, Bricks, Ank'Lay (seeds de l'app, restauration automatique au démarrage du serveur, et `node tools/restore-lifestyles.js` sur une table en cours).
- [x] Ancien train de vie de Christopher noté dans ses notes (non restauré).
- [x] Accessoires d'armes et modifications d'armure de Jane, Bricks, Ank'Lay, Christopher (restauration automatique au démarrage).
- [ ] Bricks : ajouter **Smartlink** et Interface visuelle à ses yeux cybernétiques (sinon le smartgun du Northstar est inutile).
- [ ] Jane : Signature Masking 4 sur l'Artemis Nightwing.
- [ ] Jane, Ank'Lay : revêtement polymère au ruthénium 4 sur la Second Skin (si on veut l'historique complet).
- [ ] Christopher (retiré) : grade delta et sous-systèmes des yeux, silencieux du Light Fire 75.
- [ ] Langues maternelles : anglais pour Bricks et Ank'Lay, japonais et anglais pour Christopher.

## À vérifier avec les joueurs

- **Anthony** : le supplément de 2 083 ¥/mois est-il bien un Contrat DocWagon (Or) ? Ou d'autres options (garage pour la Harley, etc.) ?
- **Jane** : le loyer passe de 5 000 à **8 583 ¥/mois** avec ses options Chummer (DocWagon Or, Ultra-sécurisé, détection de phéromones et de mensonges) : toujours d'actualité ?
- **Bricks** : loyer 7 083 ¥/mois avec DocWagon (Or) ; programmes Sneak / Exploit / Fly on a Wall et porte-programmes Baby Monitor / Wrapper ; indice de l'agent (5 ou 6).
- **Jane** : générateur de bruit blanc et scanner de signaux du commlink custom, créditube Or → Platine.
- **Christopher** : qu'est devenu l'Ares Roadmaster ? Passage de « The Hut » à « The Lounge » confirmé ?
- **Ank'Lay** : compétence Flight 1 à garder ou à oublier.
