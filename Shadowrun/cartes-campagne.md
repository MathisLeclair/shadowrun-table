# Cartes de la campagne — Fragmaps d'abord

Choix des cartes pour les lieux de Project Lazarus. Le principe : **une carte Fragmaps de la bibliothèque partout où elle colle au lieu**, et **chaque carte Fragmaps pour un seul lieu** (on ne revoit pas le même décor sous trois noms). Quand aucune carte Fragmaps ne convient, on garde le plan maison. Quand une carte Fragmaps ne couvre qu'une partie d'un grand lieu (gala, Site Glacier, Halcyon), elle sert pour les scènes rapprochées et le plan maison reste le plan d'ensemble.

Dans l'application, chaque lieu choisi est une carte de la table (onglet « Cartes de la table », dossiers **Acte 1 / Acte 2 / Acte 3**, identifiants `map_lib_…`). Ce sont des copies de la bibliothèque : murs, portes, lumières et zones déjà posés, image Fragmaps en fond, et pour chacune une description MJ (lieu, quête, ce qu'il faut adapter) et des **notes MJ** reprises des plans maison et des documents d'acte. Les plans maison remplacés sont rangés dans le dossier **« Cartes maison (anciennes) »**. Les quêtes du suivi de campagne pointent vers les nouvelles cartes.

Les cartes Foundry déjà vues par les joueurs (Bar, Back Alley, Trauma Ward, Apartement, Hacker's Lair, Corp Lobby) restent celles des lieux déjà joués : on ne change pas un décor que la table connaît.

## Acte 1 — Loose Ends

| Lieu | Carte | Pourquoi | À adapter |
|---|---|---|---|
| Bar de Porfla (Renton) — Cleanup Crew, puis cible de Reyes dans Burn Notice | **Bar** (Foundry, `map_fvtt_bar`) + plan maison `map_bar_porfla` | Déjà joué en séance 1 sur la carte Foundry ; pas une carte Fragmaps de la bibliothèque. | Rien. |
| Ruelle derrière le bar | **Ruelle** (Fragmaps free, `map_fvtt_back-alley`) | Déjà jouée. | Rien. |
| Trauma Ward (hôpital Monobe) | **Service des urgences** (Fragmaps free, `map_fvtt_trauma-ward`) | Déjà jouée, c'est le lieu exact. | Rien. |
| Appartement de Jane | **Apartement** (Foundry, `map_fvtt_apartement`) + plan maison `map_jane_apartment` | Jouée en séance 3. Le plan maison garde l'étage (voisins, escalier de secours) utile pour l'attaque de Burn Notice. | Rien. (Option non retenue : « Studio » Fragmaps, trop petit pour l'assaut.) |
| Repaire de Bricks (Hacker's Lair) | **Repaire de hacker** (Fragmaps free, `map_fvtt_hacker-s-lair`) | Joué en séances 2-3, c'est la carte d'origine du lieu. | La trappe vers le tunnel de maintenance et la cage de Faraday ne sont que sur l'ancien plan maison : à garder en tête pour Burn Notice (Perception seuil 5 pour la trappe). |
| Tour Meridian, hall (rez-de-chaussée) — séance 4 | **Hall corporatiste** (Fragmaps free, `map_fvtt_corp-lobby`) | Comptoir de sécurité, portiques, ascenseurs : le hall du plan de la séance 4. Repéré en séance 3. | Se joue surtout en narration. |
| **Hollow Pine — suite 1408 (14e)** — séance 4, approche B | **Plateau de bureaux** (`map_lib_office-floor`) | Accueil, open-space, salle de réunion vitrée, bureau de direction et **local serveur** sur une seule carte : exactement la suite 1408 du plan de séance 4 (remplace `map_corp_lobby` + `map_server_room`). | Le bureau de direction est celui d'Ashe (coffre derrière la bibliothèque) ; le second bureau et la salle de pause sont vides (une coquille). Notes : maglocks, caméras n°1-3, ronde de 40 min, arrivée de Reyes à 23 h 40. |
| Holding Von Schloss — penthouse (Klee) — Family Business, Inheritance | **Bureau en penthouse** (Fragmaps free, `map_fvtt_penthouse-office`) | Bureau de dirigeant au sommet d'une tour : la carte d'origine du lieu. | Rien. |
| Chantier près de la holding | **Chantier de construction** (Fragmaps free, `map_fvtt_construction-site`) | Carte d'origine du lieu. | Rien. |

## Acte 2 — Creuser plus profond

| Lieu | Carte | Pourquoi | À adapter |
|---|---|---|---|
| **Parc de mobil-homes de Fruitland** — Windows Open, Porte A et face-à-face avec le Passeur | **Camp de nomades** (Fragmaps free, `map_lib_nomad-camp`) | Caravanes, terrain de terre battue, carcasses : le seul décor de parc de caravanes de la bibliothèque. | Il y a moins de mobil-homes que dans le texte : numérotez ceux de la carte, la caravane du centre est le n°14 (Mama Tusker), l'enclos à poulets à côté. Le grand bâtiment au nord sert de bâtiment commun ; l'entrée carrossable est au sud. |
| **Boutique d'Old Lin (Chinatown)** — Windows Open, Porte C | **Atelier de réparation électronique** (`map_lib_electronics-repair-shop`) | Une boutique de réparation de commlinks : le lieu exact. | Rien ; la trappe sert de cache au matériel de faussaire. |
| **Laverie Suds'n'Duds (Puyallup)** — Windows Open, Phases 3-4 | **Atelier de tailleur** (`map_lib_tailor-shop`) | Vitrine sur rue, salle principale, arrière-boutique avec porte de service : la disposition de la laverie. | Remplacez dans la description les portants et vitrines de chemises par deux rangées de machines à laver et six sèche-linge empilés ; l'atelier de coupe = l'arrière-boutique (drones Doberman, porte blindée du sous-sol). La rue, l'allée et le parking : ancien plan `map_laverie_windows`. |
| **Planque de Windows (sous-sol de la laverie)** | **Local technique en sous-sol** (`map_lib_basement-utility-room`) | Escalier étroit, salle bétonnée avec… des machines à laver, grille au sol : le sous-sol d'une laverie. | Coin de vie (lit de camp, écrans) dans la « Laverie », serveur et charge thermite dans le local technique, la grille au sol = l'ancien conduit à charbon (sortie de secours). |
| **Hôtel Ravenswood — salle Aurore** — The Guest List | **Restaurant gastronomique** (`map_lib_high-class-restaurant`) | Marbre, piano à queue, estrade, bar, banquettes : un salon de gala chic, à la bonne échelle (environ 22 × 27 m). | Retirez les tables du centre pour la piste de danse ; vitrines à desserts = lots des enchères (lot n°12) ; banquettes est = zone des gardes du corps. Le plan maison `map_gala_ravenswood` reste le plan de l'étage (terrasse, couloir de service, foyer). |
| **Hôtel Ravenswood — suite privée de Wyatt-Brandt** | **Suite de direction** (`map_lib_executive-suite`) | Salon, bar, bureau privé, ascenseur privé, baies vitrées : la suite du texte. | La salle à manger vitrée = la galerie qui surplombe la salle de bal ; le vestibule de l'ascenseur = l'ascenseur privé du Jardinier. |
| **Hôtel Ravenswood — office et cuisines (Maison Duval)** | **Cuisine industrielle** (`map_lib_industrial-kitchen`) | L'entrée « en extra du traiteur » : livraisons, monte-charge, bureau du chef. | Le bureau du chef sert de vestiaire du personnel. |
| Appartement de Margaux (Capitol Hill) — optionnel | **Appartement une chambre** (`map_lib_1-bdrm`) | Le serveur du « dossier Starling » que Bricks peut aller désamorcer. | Rien. |
| Maison de Harlan Kessler (Alki Point) | **plan maison** `map_maison_kessler` | Aucune carte Fragmaps de maison de plain-pied au bord de l'eau (le « Manoir cyberpunk » est un hall de manoir à étages). | — |
| Site Glacier (ancienne usine d'embouteillage) — Lazarus Cell | **plan maison** `map_site_glacier` + **Laboratoire de recherche xénoforme** (`map_lib_xenoform-research-lab`) pour le Pavillon L et le labo de Dufresne | Le site entier (périmètre, château d'eau, salle d'embouteillage) n'existe pas en Fragmaps ; le labo xénoforme, sombre et grillagé, donne la scène rapprochée. | Salle de confinement = Pavillon L (six chambres vitrées, la 6 griffée) ; laboratoire = celui de Dufresne (cuves de culture au lieu des aquariums). |
| **Rusty Piston (bar du Crush, Touristville)** | **Bar miteux** (`map_lib_dive-bar`) | Remplace « le bar de Porfla rhabillé » : un vrai bar de gang, néons, billards, arrière-salle pour Scorch. | Motos en haut de l'escalier, couleurs du Crush. |
| **Clinique de rue (Dr Silvertongue)** — option « Où emmener les sujets ? » | **Clinique de quartier** (`map_lib_minute-clinic`) | Clinique sans rendez-vous avec lits et bloc. | Rien. |
| Funérarium Hargrove (Renton) — Lazarus Cell, Burn Notice | **plan maison** `map_funerarium_hargrove` | Pas de funérarium en Fragmaps. (L'image « cyberpunk church » du dossier fragmap n'est pas encore tracée : une fois dans la bibliothèque, elle ferait une chapelle.) | — |
| Dojo Kaze-no-Ki (International District) — Inheritance | **plan maison** `map_dojo_morinaga` | Le seul dojo Fragmaps est une salle de MMA moderne (ring, tapis de course, écrans) : contraire à l'ambiance (parquet, kamidana, papier de riz). | — |
| **Entrepôt frigorifique n°3 — VSP (Harbor Island)** — Inheritance, Phases 3-4 ; Severance, approche E | **Conserverie de fruits de mer** (`map_lib_seafood-packing-facility`) | Entrepôt frigorifique près des docks : stockage, chambre froide vitrée, quai de chargement à rideau. | Palettes de containers biomédicaux au lieu du poisson. Pas de mezzanine : Klee et Pryce sont dans les bureaux du couloir nord, Morinaga en seiza dans l'allée centrale, Reyes sur la passerelle des cuves. |

## Acte 3 — Confrontation

| Lieu | Carte | Pourquoi | À adapter |
|---|---|---|---|
| Appartement de Jane, Repaire de Bricks, Bar de Porfla (la nuit des rossignols) | mêmes cartes qu'en Acte 1 | Mêmes lieux. | — |
| **Planque Monobe (Bellevue)** — Burn Notice, Phase 3 | **Salon du caïd** (`map_lib_kingpins-meeting-room`) | Penthouse blanc, confortable, ascenseur vitré privé : « c'est confortable, et c'est une cage ». | Rien. |
| **Clinique Halcyon — hall et salons de consultation** — Severance | **Clinique privée de luxe** (`map_lib_boutique-clinic`) | Clinique esthétique de Bellevue avec bassin à koïs et jardin zen : c'est Halcyon. | Le salon des koïs = le hall à mur d'eau ; l'escalier = la porte « Personnel » de l'ascenseur de service. Le domaine (jardins, rive, parking, quai) : plan maison `map_halcyon_surface`. |
| **Clinique Halcyon — laboratoire principal (-2)** | **Laboratoire du prédateur** (`map_lib_predator-lab`, tracé « approximatif ») | Labo blanc et clinique autour d'un caisson central, chambres vitrées : le cœur du -2. | Caisson = cuve de culture ; cellule d'isolement et enclos = pavillon des sujets stabilisés. La Pépinière et le -1 restent sur `map_halcyon_sous_sols`. |
| **Clinique Halcyon — coffre de données (-2)** | **Salle des serveurs** (Fragmaps free, `map_lib_server-room`) | Salle froide, baies alignées, une seule porte blindée. Libérée par la suite 1408 qui a son propre local serveur. | Plus grande que les 5 × 4 m du texte : une seule allée de baies compte. |
| **Clinique Halcyon — la Serre (-3)** | **Laboratoire de recherche botanique** (`map_lib_greenhouse-rnd-lab`) | Serre de recherche avec paillasse centrale, salle attenante et cellule cryogénique : la Serre de Wendt. | Terre, orchidées sous lampes violettes, bureau de Wendt sur la paillasse ; salle des analyseurs = chambre de L-00 ; cellule cryogénique = archive des spécimens (cuve L-04). |

## Cartes Fragmaps encore libres (idées d'utilisation)

**En lien avec la campagne**
- **Parking (nuit)** (Fragmaps free) ou **Parking sur le toit** — le point de livraison de Windows Open (Reyes attend avec l'ambulance) ou l'arrivée de Reyes au parking de la tour Meridian (séance 4).
- **Ruelle de la poursuite**, **Course de rue** — intercepter la camionnette du Passeur (Windows Open, Phase 4) ou une fuite après la laverie.
- **Quai de chargement** — intercepter un convoi du Protokoll Ernte (Acte 3, « convoi de nuit vers le port »).
- **Entrepôt planque** — la planque du groupe après Burn Notice, ou la planque de Cabana à 3 000¥ pour Windows.
- **Studio** — la nouvelle planque de Windows, ou le motel qui ne résiste pas à Reyes.
- **Rédaction de magazine**, **Studio de diffusion indépendant**, **Studio de télévision** — fin « Lumière » : remettre les preuves à une journaliste, diffuser en direct.
- **Yacht — pont principal / passerelle / pont soleil**, **La marina** — fin « Au plus offrant » (rencontre avec l'acheteur sur le Puget Sound), ou une fuite par l'eau depuis Alki Point.
- **Bar de l'hôtel Koï**, **Salon VIP** — rendez-vous avec Saori Tanabe (Monobe) ou avec Wyatt-Brandt.
- **Hall du Lumina** — le siège de Stern Pacific ou la tour Monobe.
- **Manoir cyberpunk** (Fragmaps free) — la résidence de Wyatt-Brandt.
- **Salle de combat** — combats clandestins du Crush (gagner la confiance de Scorch).
- **Bunker à munitions** (Fragmaps free), **Marché aux armes**, **Prêteur sur gages 2049** — fournisseurs, réarmement avant Severance.
- **Bidonville (nuit)**, **Marché du cul-de-sac**, **Sous l'échangeur**, **Parking abandonné** — Touristville et les Redmond Barrens (la mission du père Ruiz, les Moissonneurs, le Crush).
- **Bar à chicha**, **Diner** (Fragmaps free), **Café Zéro** — rendez-vous avec Cabana ou un Johnson.
- **Laboratoire biologique** (Fragmaps free) — un labo Monobe pour la fin « Au plus offrant ».
- **Bureau de détective privé** — Dutch Haldane, le fixer de Tacoma du Passeur.

**Jobs annexes et rencontres**
- Triades / Chinatown : **Restaurant de la Maison du Dragon**, **Cuisine de restaurant chinois**, **Boucherie**, **Salon de massage**.
- Yakuzas : **QG yakuza** (le passé de Morinaga ?).
- Arnaques de Jane : **Galerie d'art**, **Bijouterie de luxe**, **Magasin de sport**.
- Rue : **Ruelle des food trucks**, **Toilettes publiques**, **Salon de tatouage**, **Salle d'arcade**, **Boutique de curiosités**, **Gare routière**, **Terminus** (Fragmaps free), **Rue marchande (nuit)** (Fragmaps free), **Centre commercial Horizon** (Fragmaps free), **Fast-food**, **Station-service**, **Boîte de nuit**, **Jardin sur le toit** (carte de jour).
- Industriel : **Entrepôt** (Fragmaps free), **Casse automobile**, **Serre clandestine**, **Station d'épuration**, **Boutique incendiée**, **Théâtre abandonné**, **Hangar** (Fragmaps free).
- Hors de Seattle (pour une suite) : **Poste-frontière du désert**, **Trafic d'armes en bord de route**, **Piste d'atterrissage dans la jungle**.

## Sur la table en ligne

- Les nouvelles cartes s'ajoutent à la table au redémarrage du serveur ; une carte déjà présente n'est jamais remplacée.
- Les quêtes que vous n'avez jamais modifiées prennent les nouvelles listes de cartes. Une quête modifiée dans l'application (statut, phase cochée, notes…) garde sa liste : ajoutez-y les cartes `map_lib_…` à la main si besoin.
- Les plans maison déjà présents dans la table restent dans leur dossier (Acte 1 / Acte 2) : le classement « Cartes maison (anciennes) » ne vaut que pour une nouvelle table. Déplacez-les à la main si vous voulez.
- Les images Fragmaps doivent être copiées sur le serveur (dossier de la bibliothèque) : sans elles, la carte s'affiche avec un fond gris, murs et notes compris.
