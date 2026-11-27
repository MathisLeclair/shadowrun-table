#!/usr/bin/env node
// Project Lazarus: table maps (instances) made from the map library for the campaign's locations — the
// « Fragmaps first » choice of Shadowrun/cartes-campagne.md. Writes data/seed/maps/lib-<slug>.json (one Map per file,
// map.library = { slug, version }), built exactly like the GM action maps/fromLibrary (server/modules/22-maplib.ts):
// same geometry, walls / doors / lights / regions with ids, « Entrée » GM region — plus the campaign name, folder,
// GM description and GM notes below. Ids are deterministic, so re-running only rewrites what changed.
//   node tools/maplib-campaign-seeds.ts [--dry]
// The library is loaded into a throw-away folder (os tmpdir): data/maplib/*.json + the Foundry fragmaps-free seeds.
// Seeds only ADD maps to a table (20-maps.ts init): a live table keeps its own copy once it has one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameMap, Lighting } from '../shared/types.ts';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(APP, 'data', 'seed', 'maps');
const DRY = process.argv.includes('--dry');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-maplib-seeds-'));
process.env.SR_RUNTIME_DIR = TMP;
process.env.SR_MAPLIB_DIR = path.join(TMP, 'maplib');
process.env.SR_MAPLIB_KEY_FILE = path.join(TMP, 'maplib-sign.key');

const L = await import('../server/lib/maplib.ts');
const { libImageUrl, libGeometry, instanceContent } = await import('../shared/maplib.ts');
const { normalizeMap } = await import('../server/modules/20-maps.ts');

const LINKED_AT = Date.UTC(2026, 10, 26);
const A1 = 'Acte 1', A2 = 'Acte 2', A3 = 'Acte 3';

// ---------------------------------------------------------------------------------------------------------------
// The campaign locations. `slug` = library entry (git data/maplib), or `image` = a Foundry fragmaps-free scene image
// (its library slug is made at boot from the seed). Notes: `at` = a region name of the library map (centre), or [x, y].
// ---------------------------------------------------------------------------------------------------------------
/** A campaign location: a library entry (`slug`) or a Foundry scene image (`image`), with its campaign texts. */
interface CampaignLocation {
  slug?: string;
  image?: string;
  folder: string;
  quest: string;
  name: string;
  use: string;
  adapt: string;
  lighting?: Lighting;
  /** `at`: a region name of the library map (its centre) or a cell [x, y]. */
  notes: Array<{ at: string | [number, number]; text: string }>;
}

const LOCATIONS: CampaignLocation[] = [
  {
    slug: 'office-floor', folder: A1, quest: 'Open Book (séance 4, approche B)',
    name: 'Hollow Pine — suite 1408 (tour Meridian, 14e)',
    use: 'Les bureaux de Hollow Pine Holdings au 14e étage de la tour Meridian (5th Avenue, Downtown). Le hall du rez-de-chaussée se joue sur « Corp Lobby » (Foundry) ou en narration.',
    adapt: 'Le « Bureau de direction » est celui de Dorian Ashe, le « Local serveur » est la salle serveur de la suite (plus besoin d’une carte séparée). Le second bureau vitré et la salle de pause sont vides : c’est une coquille.',
    notes: [
      { at: 'Accueil', text: 'Porte de la suite : verre dépoli, cadre acier, logo au pin creux. Maglock rating 4 (badge + code à 4 chiffres). Caméra n°1 au-dessus, côté intérieur. Accueil : comptoir laqué blanc, mur végétal, caméra n°2. Le terminal de l’accueil est esclave du host (connexion directe = +2 dés pour Bricks).' },
      { at: 'Open-space', text: 'Plateau ouvert : quatre postes vides, très peu personnalisés — personne ne travaille vraiment ici. Tiroirs : fournitures neuves, baux commerciaux sans intérêt. Bureaux = couverture partielle ; cloisons vitrées = aucune.' },
      { at: 'Salle de réunion', text: 'Table en verre, baie vitrée sur la ville : la fenêtre que la nacelle du laveur de vitres (toit, accès par la cage du 22e, maglock 3) permet d’atteindre. Verre renforcé non ouvrant (Structure 6, Armor 6) : 10 min de découpe, ou Athletics/Gymnastics pour tenir en place pendant qu’un autre découpe.' },
      { at: 'Bureau de direction', text: 'Bureau de Dorian Ashe, le seul endroit vivant : orchidées, photo d’Ashe avec Cornelius Wyatt-Brandt au gala Halcyon, bibliothèque de droit des sociétés. Derrière un panneau : le coffre (mécanique + pavé, rating 4 ; Locksmith + Agility seuil 4 ou autopicker). Contenu : voir Phase 4 (dossier 0419).' },
      { at: 'Local serveur', text: 'Salle serveur : porte blindée, maglock biométrique rating 5 (paume d’Ashe ou de l’admin du prestataire). Deux baies, console de maintenance (accès direct au host, sans bruit), clim bruyante (–2 Perception auditive). Caméra n°3. Enfoncer la porte (Structure 12, Armor 12) déclenche l’alarme.' },
      { at: 'Cage d\'escalier', text: 'Escalier de secours verrouillé côté cage (maglock rating 3, alarme à l’ouverture après 22 h). Ronde du garde de la tour toutes les 40 min (14e : 22 h 20, 23 h 00, 23 h 40). À 23 h 40, Reyes + 2 Nettoyeurs montent avec un badge valide : 12 minutes sur place (coffre, classeur, agent d’effacement).' },
      { at: 'Couloir', text: 'De nuit : veilleuses au sol seulement (pénombre, –1 visuel sans Low-Light). Si le host est en alerte, les détecteurs de mouvement allument les plafonniers de l’accueil et du plateau.' },
    ],
  },
  {
    image: 'nomad-camp.jpg', folder: A2, quest: 'Windows Open (Porte A, Phase 2)',
    name: 'Parc de mobil-homes de Fruitland (Puyallup)',
    use: 'Le parc de mobil-homes où vit Mama Odile Tusker (mobil-home 14) ; le face-à-face avec le Passeur.',
    adapt: 'Moins de mobil-homes que dans le texte : numérotez ceux de la carte, la caravane du centre est le n°14. Les conteneurs et cuves de l’ouest sont la friche industrielle voisine ; le grand bâtiment du nord sert de bâtiment commun (laverie hors service, boîtes aux lettres).',
    notes: [
      { at: [16, 22], text: 'Mobil-home 14 — Mama Odile Tusker, vieille orque. Elle a connu « la fille aux lunettes » : Windows lui envoie chaque mois un colis de graines « pour les poules ». Etiquette (Street) + Charisme seuil 2, ou 50¥ et de la patience → boîte postale d’une épicerie de Puyallup centre (+2 Piste). SECRET : sous l’évier, la clé USB de Windows (message de Vosk + manifeste SP-NULL), donnée seulement de la part de Windows ou si elle a été enlevée.' },
      { at: [8, 23], text: 'Enclos à poulets mutants (8 × 6 m, grillagé) : toute intrusion à moins de 3 m la nuit les fait caqueter — +2 dés en Perception pour les habitants. Bonne diversion aussi.' },
      { at: [13, 44], text: 'Entrée sud (barrière levante cassée) : seule entrée carrossable. Phase 2 : la camionnette GMC Bulldog grise du Passeur se gare ici. Le Passeur descend seul, mains visibles ; Mosaïque reste dans la camionnette, Rempart adossé au capot, Cendre côté passager. Négociation contre 8 dés (3 succès nets = il rompt le contrat) ; acheter : 50 000¥.' },
      { at: [10, 5], text: 'Bâtiment commun : laverie hors service et boîtes aux lettres. L’ancienne boîte de Windows est vide (Perception seuil 2 : étiquette grattée, il reste « R. W »).' },
      { at: [10, 26], text: 'Carcasses de voitures / barbecue en béton : couverture lourde (Armor 8). Parois des mobil-homes : Armor 4 / Structure 6, les balles traversent. Une dizaine d’habitants orks témoins, hostiles aux flics comme aux fusillades : un combat ici = Horloge +1.' },
    ],
  },
  {
    slug: 'electronics-repair-shop', folder: A2, quest: 'Windows Open (Porte C)',
    name: 'Boutique d’Old Lin (Chinatown)',
    use: 'La boutique de réparation de commlinks d’Old Lin, faussaire de SIN rating 4 : elle a vendu son identité « Rae Calder » à Windows.',
    adapt: 'Rien à changer : l’atelier est la boutique, la réserve et la trappe servent pour le matériel de faussaire.',
    notes: [
      { at: 'Atelier', text: 'Old Lin ne vend pas ses clients, elle vend des services. Negotiation + Charisme contre 8 dés (Street Cred de Jane : +2 dés) ; 1 000¥ de « frais » ou un service (lui rapporter un commlink volé chez un concurrent) → l’identité : Rae Calder, propriétaire d’une laverie (+2 Piste). Menacée, elle donne le nom… et appelle Windows juste après.' },
      { at: 'Trappe', text: 'Suggestion : sous la trappe, le vrai atelier de faussaire (imprimantes de SIN, lecteurs biométriques). Old Lin n’y emmène personne.' },
    ],
  },
  {
    slug: 'tailor-shop', folder: A2, quest: 'Windows Open (Phases 3-4)',
    name: 'Laverie Suds’n’Duds (Puyallup)',
    use: 'Le rez-de-chaussée de la laverie de « Rae Calder » (Windows). Le sous-sol est une carte à part (« Planque de Windows »), la rue, l’allée et le parking restent sur l’ancien plan « Laverie Suds’n’Duds et planque de Windows ».',
    adapt: 'Remplacez dans la description les portants et les vitrines de chemises par deux rangées de machines à laver et six sèche-linge empilés ; l’« Atelier de coupe » est l’arrière-boutique (porte « Privé », lessive, chaudière, drones), et sa porte de service donne sur l’allée.',
    notes: [
      { at: 'Entrée', text: 'Vitrine et porte vitrée automatique : verre ordinaire. Ouvert 24 h/24 ; à 3 h du matin, un ou deux clients de passage (témoins). Néons blancs fatigués, éclairée en permanence.' },
      { at: 'Boutique', text: 'Salle des machines : machines = couverture partielle (Armor 6, Structure 8) ; sèche-linge en marche : –2 Perception auditive. Trois des six sèche-linge cachent des caméras câblées vers le sous-sol (Perception + Intuition seuil 4). Fly-Spy de Windows dans une dalle du faux plafond : il voit les assaillants à deux rues (3 tours d’avance).' },
      { at: 'Atelier de coupe', text: 'Arrière-boutique (porte « Privé », serrure mécanique rating 2) : étagères de lessive, chaudière, deux drones GMC-Nissan Doberman en veille (Colt Cobra TZ-120). Porte blindée vers l’escalier du sous-sol : Structure 12 / Armor 12, maglock rating 5 câblé (séquenceur ou accès physique). Porte forcée = interrupteur d’homme mort.' },
      { at: 'Rayon chemises', text: 'Si Reyes vient : 2 Crimson Crush à moto en guetteurs au coin de la rue ; Reyes + 4 Nettoyeurs entrent par la vitrine ET par l’allée. Équipe du Passeur (Phase 4) : Rempart enfonce la porte de service, le Passeur et Cendre entrent par la vitrine ; ils veulent Windows vivante.' },
    ],
  },
  {
    slug: 'basement-utility-room', folder: A2, quest: 'Windows Open (Phases 3-5)',
    name: 'Planque de Windows (sous-sol de la laverie)',
    use: 'Le sous-sol de la laverie Suds’n’Duds : la planque de Windows, cage de Faraday.',
    adapt: 'Le palier et l’escalier sont l’arrivée depuis l’arrière-boutique. La « Laverie » devient le coin de vie (lit de camp, kitchenette, trois écrans), le « Local technique » l’armoire du serveur, et la grille au sol l’ancien conduit à charbon.',
    notes: [
      { at: 'Escalier', text: 'Escalier étroit : une seule personne à la fois — le goulot de l’assaut. La porte blindée en haut est câblée à l’interrupteur d’homme mort.' },
      { at: 'Local technique', text: 'Cage de Faraday : aucune connexion sans fil n’entre ni ne sort (Bricks est coupée de la Matrice). Windows (pistolet braqué) ouvre si Bricks se présente devant une caméra. Serveur dans une armoire métallique, charge thermite reliée au bracelet de Windows : pression relâchée ou porte forcée → effacement en 30 s.' },
      { at: 'Laverie', text: 'Mur couvert de photos et de fils rouges : six ans d’enquête sur Harlan Kessler. Au centre, une photo de l’Escouade 9 — Bricks y est.' },
      { at: 'Grille au sol', text: 'Ancien conduit à charbon (0,8 m), caché (Perception seuil 4) : on y rampe une personne à la fois (déplacement /2). Il remonte dans l’allée par une trappe en fonte — l’issue de secours de Windows.' },
    ],
  },
  {
    slug: 'high-class-restaurant', folder: A2, quest: 'The Guest List',
    name: 'Hôtel Ravenswood — salle Aurore (gala Halcyon)',
    use: 'Le gala de la Fondation Halcyon, 31e étage de l’hôtel Ravenswood (Downtown) : la salle de bal. La suite privée et les cuisines sont des cartes à part ; l’ancien plan « Hôtel Ravenswood, 31e étage » reste le plan d’ensemble (terrasse, couloir de service, foyer).',
    adapt: 'Retirez les tables du milieu pour la piste de danse ; l’estrade accueille les discours et le quatuor à cordes (le piano reste). Les « Vitrines à desserts » deviennent les lots de la vente aux enchères (lot n°12 : la brochure Halcyon). Les banquettes est = la zone des gardes du corps ; le passe-plats mène à l’office.',
    notes: [
      { at: 'Accueil', text: 'Foyer : contrôle des invitations (2 agents de l’hôtel, lecteur RFID), vestiaire, portique de détection d’armes (les gardes du corps déclarés passent à côté). Si Margaux joue sa carte : six gardes Stern Pacific attendent Jane au vestiaire.' },
      { at: 'Estrade', text: 'Discours et quatuor à cordes. 6 agents Stern Pacific en civil sous les ordres de Kessler ; Reyes dans l’équipe discrète si l’Horloge est à 4 ou plus. Caméras partout (esclaves du host de l’hôtel), aucune dans la suite privée.' },
      { at: 'Banquettes est', text: 'Zone des gardes du corps privés des invités (une douzaine de tpl_bodyguard_r5).' },
      { at: 'Vitrines à desserts', text: 'Salon des enchères : les lots sous vitrine, dont le lot n°12 (brochure de la Clinique Halcyon).' },
    ],
  },
  {
    slug: 'executive-suite', folder: A2, quest: 'The Guest List (Phase 4)',
    name: 'Hôtel Ravenswood — suite privée de Wyatt-Brandt',
    use: 'La suite privée du 31e : salon, bureau avec le coffre numérique, ascenseur privé vers le parking.',
    adapt: 'La « Salle à manger et baies vitrées » sert de galerie vitrée qui surplombe la salle de bal ; le « Vestibule de l’ascenseur » est l’ascenseur privé (Jardinier et Morinaga partent par là à 23 h 15). L’« Entrée de service » donne sur le couloir de service (maglock rating 4).',
    notes: [
      { at: 'Bureau', text: 'Terminal et coffre numérique, esclaves du PAN privé de Wyatt-Brandt (rating 6, Firewall 8), accessible à 30 m seulement : la liste des clients VIP (43 noms) et la place du mouchard de Monobe.' },
      { at: 'Salle à manger et baies vitrées', text: 'Galerie vitrée (12 × 3 m) au-dessus de la salle de bal, accessible seulement depuis la suite. À 22 h 30, Wyatt-Brandt y monte avec ses invités ; à 23 h 15, le Jardinier la quitte par l’ascenseur privé, avec Morinaga.' },
      { at: 'Entrée de service', text: 'Porte de service sur le couloir qui fait le tour de l’étage : maglock rating 4. Aucune caméra dans la suite.' },
    ],
  },
  {
    slug: 'industrial-kitchen', folder: A2, quest: 'The Guest List',
    name: 'Hôtel Ravenswood — office et cuisines (Maison Duval)',
    use: 'L’office du traiteur Maison Duval au 31e : l’entrée discrète du gala (Jane ou un runner en extra du personnel).',
    adapt: 'Les « Livraisons » sont le monte-charge et l’ascenseur de service (badge du personnel) ; le bureau du chef sert de vestiaire du personnel.',
    notes: [
      { at: 'Livraisons', text: 'Monte-charge, ascenseur de service (badge personnel) et escalier de service. Le couloir de service (2 m) part d’ici, fait le tour de l’étage et mène à la porte de service de la suite privée.' },
      { at: 'Bureau du chef', text: 'Vestiaire du personnel : tenues de serveur Maison Duval, plannings — Margaux (retournée) connaît les codes du personnel.' },
    ],
  },
  {
    slug: '1-bdrm', folder: A2, quest: 'The Guest List (Margaux, optionnel)',
    name: 'Appartement de Margaux (Capitol Hill)',
    use: 'L’appartement de Capitol Hill où tourne le serveur du « dossier Starling » de Margaux « La Pie » Hale (interrupteur d’homme mort de 48 h).',
    adapt: 'Rien à changer : le serveur est sur le poste de travail du séjour.',
    notes: [
      { at: 'Séjour', text: 'Serveur du dossier Starling : host personnel rating 3, facile — si on y pense. Si Margaux disparaît ou ne se connecte pas pendant 48 h, le fichier part à Knight Errant et à Dorian Ashe.' },
    ],
  },
  {
    slug: 'dive-bar', folder: A2, quest: 'Lazarus Cell (Phase 2)',
    name: 'Rusty Piston (bar du Crush, Touristville)',
    use: 'Le bar des motards de Crimson Crush à Touristville, où l’on traite avec Scorch (remplace « le bar de Porfla rhabillé »).',
    adapt: 'Ajoutez des motos garées en haut de l’escalier côté rue et des couleurs du Crush aux murs. L’arrière-salle est le coin de Scorch.',
    notes: [
      { at: 'Arrière-salle', text: 'Scorch, lieutenante de Crimson Crush. Elle refuse de parler du « contrat de gardiennage chez les blouses blanches » (le Site Glacier) — ce qui en dit long. Voir act2, Lazarus Cell, Phase 2, pour les façons de traiter avec elle.' },
      { at: 'Escalier (rue)', text: 'Les motos du Crush sont garées en haut de l’escalier : personne n’entre ni ne sort sans être vu.' },
    ],
  },
  {
    slug: 'xenoform-research-lab', folder: A2, quest: 'Lazarus Cell (Phases 3-5)',
    name: 'Site Glacier — Pavillon L et labo de Dufresne',
    use: 'L’intérieur du Site Glacier pour les scènes rapprochées : le laboratoire de la Dr. Dufresne et le Pavillon L. Le reste du site (périmètre, château d’eau, salle d’embouteillage, salle des donneurs) reste sur l’ancien plan « Site Glacier ».',
    adapt: 'La « Salle de confinement » grillagée est le Pavillon L : six chambres vitrées (L-03, L-05, L-09, L-11, une vide, une à la porte renforcée et griffée). Le « Laboratoire » est celui de Dufresne (centrifugeuses, cuves, serveur local, classeurs) ; remplacez les aquariums par des cuves de culture.',
    notes: [
      { at: 'Laboratoire', text: 'Dr. Hélène Dufresne, là la nuit. Elle ne se bat pas, elle protège ses données. Retournable : Negotiation + Charisme contre 7 dés, +3 si le groupe lui garantit une sortie (fille à Bruxelles). Serveur local + classeurs métalliques : dossiers papier des sujets, dont celui de L-02.' },
      { at: 'Salle de confinement', text: 'Pavillon L : chambres vitrées (verre renforcé Armor 6, Structure 6 ; maglocks rating 4). Ch. 1-4 : L-03, L-05, L-09, L-11. Ch. 5 vide, prête pour un transfert. Ch. 6 vide, porte renforcée, griffures. Néons allumés en permanence.' },
      { at: 'Postes de contrôle', text: 'Gardes AG Chemie (tpl_corpsec_r4) : 2 en ronde, 2 en salle de sécurité, 4 au repos ; Stadler ; une mage de sécurité en ronde astrale toutes les heures ; Junior Spider.' },
    ],
  },
  {
    slug: 'minute-clinic', folder: A2, quest: 'Lazarus Cell (option « Où les emmener ? »)',
    name: 'Clinique de rue (Docteur Silvertongue)',
    use: 'La clinique de rue où le groupe peut soigner les sujets libérés du Site Glacier (ou un runner blessé) — option « Ork Underground, Docteur Silvertongue ou équivalent ».',
    adapt: 'Rien à changer. Chaque refuge a ses conséquences en Acte 3 : une clinique de rue parle si on la paie.',
    notes: [
      { at: 'Lits', text: 'Quatre sujets sous sédation qui marchent mal : il faut des lits, des perfusions, et quelqu’un pour se taire. Le doc veut être payé — et AG Chemie paie mieux que le groupe si l’Horloge monte.' },
    ],
  },
  {
    slug: 'seafood-packing-facility', folder: A2, quest: 'Inheritance (Phases 3-4) ; Severance (approche E)',
    name: 'Entrepôt frigorifique n°3 — VSP Holding (Harbor Island)',
    use: 'L’entrepôt frigorifique certifié de la holding Von Schloss, sur Harbor Island : Klee y est retenu. En Acte 3, la camionnette réfrigérée en part (cheval de Troie de Severance).',
    adapt: 'Remplacez le poisson par des palettes de containers biomédicaux (rayonnages de l’« Entrepôt ») et les thons de la chambre froide par des caisses isothermes. Pas de mezzanine : les bureaux sont l’annexe du « Couloir nord » (Klee, Pryce, le terminal), Morinaga attend en seiza dans l’allée centrale, et la cabine de Reyes est la passerelle au-dessus des cuves.',
    notes: [
      { at: 'Quai de chargement', text: 'Portail à badge : codes de la holding (Klee, ou Anthony s’il les a). Camionnette réfrigérée de VSP à quai (balise du médaillon de Klee). 2 Crimson Crush près de la porte ouverte : ils fument, ils ont froid, ils s’ennuient.' },
      { at: 'Entrepôt', text: 'Palettes de containers biomédicaux : couverture lourde (Armor 8), mais chaque tir perdu détruit la marchandise de VSP. 2 Crimson Crush en patrouille. –5 °C : givre (–1 Agility pour courir), brouillard (–1 visuel au-delà de 20 m).' },
      { at: 'Chambre froide', text: '–25 °C, porte isotherme coulissante avec ouverture intérieure de sécurité. Enfermé sans protection : 1 case d’Étourdissement toutes les 5 minutes (Body + Willpower seuil 2). Idéal pour enfermer des gardes… ou se cacher.' },
      { at: 'Couloir nord', text: 'Bureaux du quai : Reinhardt Klee attaché sur une chaise devant le terminal du contrat (sceau familial + clé de la banque). Me Desmond Pryce, non-combattant, terrifié : il parle à la moindre menace. 2 Nettoyeurs : faire signer, puis « l’accident ».' },
      { at: 'Allée centrale', text: 'Morinaga, assis en seiza, les yeux fermés. Il ne se lève pas tant que personne ne passe. Si Anthony approche : il se place entre lui et Klee — « Montre-moi. » S’il achève un garde à terre devant lui : jauge –1, et seulement « Ah. »' },
      { at: 'Cuves', text: 'Passerelle au-dessus des cuves : poste de Reyes avec un fusil si l’Horloge ≥ 6 (vue sur tout le hall). Si Morinaga est en danger de mort, elle lance une grenade fumigène et l’emmène.' },
    ],
  },
  {
    slug: 'kingpins-meeting-room', folder: A3, quest: 'Burn Notice (Phase 3)',
    name: 'Planque Monobe (Bellevue)',
    use: 'La planque offerte par Saori Tanabe dans un immeuble résidentiel corporatiste de Monobe, à cinq rues de Halcyon. Prix : une copie de tout ce que le groupe possède.',
    adapt: 'Rien à changer : c’est confortable, et c’est une cage (l’ascenseur vitré est contrôlé par Monobe).',
    notes: [
      { at: 'Ascenseur vitré', text: 'Suggestion : ascenseur privé contrôlé par la sécurité de Monobe : on entre et on sort quand Monobe le veut. Caméras de l’immeuble esclaves du host de Monobe.' },
    ],
  },
  {
    slug: 'boutique-clinic', folder: A3, quest: 'Severance (approche A, surface)',
    name: 'Clinique Halcyon — hall et salons de consultation',
    use: 'Le rez-de-chaussée de la Clinique Halcyon (Bellevue) pour les scènes rapprochées : accueil, salons de consultation, accès à l’ascenseur de service. Le domaine (jardins, rive, parking, quai) reste sur l’ancien plan « Clinique Halcyon — surface ».',
    adapt: 'Le « Salon d’attente (koïs) » est le hall à mur d’eau et orchidées ; les salles d’examen sont deux des six salons de consultation de l’aile ouest ; l’« Escalier » est la porte « Personnel » de l’ascenseur de service (badge + code, vers le -1 et le -2). Le bloc opératoire est fermé la nuit.',
    notes: [
      { at: 'Accueil', text: 'Comptoir d’accueil : 2 gardes de nuit (tpl_corpsec_human_r3). Approche A : Impersonation + Charisme contre 6 dés pour entrer comme cliente VIP, puis Con + Charisme contre l’infirmier-chef (7 dés) pour refuser l’examen sanguin.' },
      { at: 'Escalier', text: 'Porte « Personnel » : ascenseur de service (badge + code) vers le -1 et le -2. Rondes : 4 gardes Werkschutz en binômes, passage toutes les 20 minutes.' },
    ],
  },
  {
    slug: 'predator-lab', folder: A3, quest: 'Severance (niveau -2)',
    name: 'Clinique Halcyon — laboratoire principal (-2)',
    use: 'Le laboratoire principal du niveau -2 et le pavillon des sujets stabilisés. La Pépinière, le niveau -1 et la vue d’ensemble restent sur l’ancien plan « Clinique Halcyon — niveaux -1, -2 et -3 ».',
    adapt: 'Le caisson de stase central devient la cuve de culture principale ; la « Cellule d’isolement » et l’« Enclos » sont des chambres du pavillon des sujets (portes vitrées, maglock rating 5) — un allié enlevé pendant Burn Notice y attend. La « Baie de chargement » est l’arrivée du monte-charge du quai.',
    notes: [
      { at: 'Laboratoire', text: 'Laboratoire principal : cuves de culture, séquenceurs, centrifugeuses (couverture partielle). Lumière blanche crue, aucune ombre utile. Le mage de sécurité et 4 gardes tpl_corpsec_r4 patrouillent le niveau.' },
      { at: 'Cellule d\'isolement', text: 'Pavillon des sujets stabilisés : chambres à portes vitrées, maglock rating 5. Si L-07 a été reprise, elle est ici : une chambre dorée et une perfusion.' },
      { at: 'Sas', text: 'Protokoll Asche : la valve de la Pépinière et les 4 charges thermiques du coffre de données se déclenchent depuis le poste central du -1 (horloge de 10 tours).' },
    ],
  },
  {
    image: 'server-room.jpg', folder: A3, quest: 'Severance (niveau -2)',
    name: 'Clinique Halcyon — coffre de données (-2)',
    use: 'Le coffre de données du niveau -2 : baie de serveurs isolés, accès physique uniquement.',
    adapt: 'La salle est plus grande que les 5 × 4 m du texte : ne gardez qu’une allée de baies, le reste est la salle froide. Une seule porte blindée.',
    notes: [
      { at: [9, 6], text: 'Porte blindée Structure 16 / Armor 16, maglock rating 6. Salle froide, aucune connexion sans fil : Bricks doit se brancher (Computer + Logic [Data Processing], test étendu, seuil 12, intervalle 1 tour pour tout copier ; protocole seul : 6 ; Escouade 9 + ordres de Wendt : 4). 4 charges thermiques du Protokoll Asche.' },
    ],
  },
  {
    slug: 'greenhouse-rnd-lab', folder: A3, quest: 'Severance (niveau -3)',
    name: 'Clinique Halcyon — la Serre (-3)',
    use: 'La Serre du niveau -3 : le bureau-jardin du Jardinier (Dr. Ansgar Wendt), la chambre de traitement de L-00, l’archive des spécimens.',
    adapt: 'Ajoutez de la terre, des orchidées sous lampes horticoles (lumière violette et chaude), un petit bassin et le bureau en bois clair de Wendt sur la « Paillasse centrale ». Le « Sas vitré » est l’antichambre de l’ascenseur privé (Morinaga y attend, selon la jauge) ; la « Salle des analyseurs » est la chambre de traitement de L-00, la « Cellule cryogénique » l’archive des spécimens.',
    notes: [
      { at: 'Paillasse centrale', text: 'Bureau de Wendt : terminal sur circuit fermé (Protokoll Asche, tunnel, dossiers personnels). Bacs de plantation = couverture partielle (Armor 4), piliers = couverture lourde. Danny (L-02) et 2 gardes du corps tpl_bodyguard_r5.' },
      { at: 'Cellule cryogénique', text: 'Archive des spécimens, porte grise : cuves de formol étiquetées L-01, L-04, L-06-A… Dans la cuve L-04, Kim Jae-won. Si Bricks entre, ne demandez rien. Laissez-la regarder.' },
      { at: 'Plan de travail', text: 'Tunnel d’évacuation : porte blindée derrière un treillage de lierre (biométrie de Wendt), 120 m, débouche au -2 du parking de l’immeuble voisin (berline blindée). Wendt l’atteint en 4 tours.' },
    ],
  },
];

// ---------------------------------------------------------------------------------------------------------------
L.ensureLibrary();
const written: Array<{ id: string; slug: string; size: string; walls: number; notes: number; name: string }> = [];
for (const loc of LOCATIONS) {
  const m = loc.slug ? L.getMeta(loc.slug) : L.findByImage(loc.image || '');
  if (!m) throw new Error(`library entry not found: ${loc.slug || loc.image}`);
  const v = L.getVersion(m.slug);
  if (!v) throw new Error(`library entry without a version: ${m.slug}`);
  const e = L.effective(m);
  const g = libGeometry({ ...e, ...(v.geometry || {}) });
  let n = 0;
  const uid = (p: string) => `${p}_${m.slug}_${++n}`;
  const content = instanceContent(v, uid);
  const regionAt = (name: string): [number, number] => {
    const r = (v.regions || []).find((x) => x.name === name);
    if (!r) throw new Error(`${m.slug}: no region « ${name} »`);
    return [Math.floor(r.x + r.w / 2), Math.floor(r.y + r.h / 2)];
  };
  const notes = (loc.notes || []).map((note, i) => {
    const [x, y] = Array.isArray(note.at) ? note.at : regionAt(note.at);
    return { id: `note_${m.slug}_${i + 1}`, x, y, text: note.text, gmOnly: true };
  });
  const description = [
    `**Lieu de campagne :** ${loc.use}`,
    `**Quête :** ${loc.quest}.`,
    `**À adapter :** ${loc.adapt}`,
    `**La carte (bibliothèque Fragmaps, « ${e.nameFr || e.name} ») :** ${e.description || ''}`,
    'Voir Shadowrun/cartes-campagne.md.',
  ].join('\n\n');
  const map = normalizeMap({
    id: `map_lib_${m.slug}`,
    name: loc.name,
    folder: loc.folder,
    description,
    width: g.width, height: g.height, metersPerCell: e.metersPerCell, theme: e.theme, lighting: loc.lighting || e.lighting,
    tiles: Array.from({ length: g.height }, () => '.'.repeat(g.width)),
    background: { url: libImageUrl(m.slug), opacity: 1, mode: 'image', x: g.bgX, y: g.bgY, w: g.bgW, h: g.bgH },
    walls: content.walls, lights: content.lights, regions: content.regions,
    doors: [], notes, tokens: [], fog: true,
  });
  delete (map as Partial<GameMap>).explored;
  map.library = { slug: m.slug, version: m.version, linkedAt: LINKED_AT };
  const file = path.join(OUT, `lib-${m.slug}.json`);
  if (!DRY) fs.writeFileSync(file, JSON.stringify(map, null, 2) + '\n');
  written.push({ id: map.id, slug: m.slug, size: `${map.width}×${map.height}`, walls: map.walls.length, notes: notes.length, name: map.name });
}
fs.rmSync(TMP, { recursive: true, force: true });
for (const w of written) console.log(`${DRY ? '(dry) ' : ''}${w.id.padEnd(38)} ${w.size.padEnd(7)} murs ${String(w.walls).padStart(4)}  notes ${w.notes}  ${w.name}`);
console.log(`${written.length} carte(s)${DRY ? ' (rien écrit)' : ` → ${path.relative(APP, OUT)}`}`);
