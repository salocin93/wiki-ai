// Starter questions and suggestions in the answer language (Settings › Answer language). Languages not listed
// here get English.
const PHRASES = {
  en: {
    summary: 'Summarize this article in a few bullet points',
    summaryOf: (t) => `Summarize “${t}” in a few bullet points`,
    explain: (x) => `Explain the section “${x}”`,
    meanings: (t) => `Which meanings of “${t}” are listed here?`,
    whatIs: (x) => `What is “${x}”?`,
    section: 'Explain the section I am reading',
    readNext: 'Which linked articles should I read next, and why?',
    overview: 'Give me an overview of this topic and its main themes',
    connect: (a, b) => `How is “${a}” connected to “${b}”?`,
    connected: 'How are the articles in this topic connected?',
    theme: (c) => `What should I know about “${c}”?`,
    readFirst: 'Which articles in this topic should I read first, and why?',
    fit: (x) => `How does ${x} fit into this topic?`,
    about: (x) => `Tell me about ${x} and how it connects to the rest of this topic.`,
  },
  de: {
    summary: 'Fasse diesen Artikel in ein paar Stichpunkten zusammen',
    summaryOf: (t) => `Fasse „${t}“ in ein paar Stichpunkten zusammen`,
    explain: (x) => `Erkläre den Abschnitt „${x}“`,
    meanings: (t) => `Welche Bedeutungen von „${t}“ werden hier aufgeführt?`,
    whatIs: (x) => `Was ist „${x}“?`,
    section: 'Erkläre den Abschnitt, den ich gerade lese',
    readNext: 'Welche verlinkten Artikel sollte ich als Nächstes lesen, und warum?',
    overview: 'Gib mir einen Überblick über dieses Thema und seine wichtigsten Schwerpunkte',
    connect: (a, b) => `Wie hängt „${a}“ mit „${b}“ zusammen?`,
    connected: 'Wie hängen die Artikel dieses Themas zusammen?',
    theme: (c) => `Was sollte ich über „${c}“ wissen?`,
    readFirst: 'Welche Artikel dieses Themas sollte ich zuerst lesen, und warum?',
    fit: (x) => `Wie passt ${x} in dieses Thema?`,
    about: (x) => `Erzähl mir von ${x} und wie es mit dem Rest dieses Themas zusammenhängt.`,
  },
  fr: {
    summary: 'Résume cet article en quelques points',
    summaryOf: (t) => `Résume « ${t} » en quelques points`,
    explain: (x) => `Explique la section « ${x} »`,
    meanings: (t) => `Quels sens de « ${t} » sont listés ici ?`,
    whatIs: (x) => `Qu'est-ce que « ${x} » ?`,
    section: 'Explique la section que je lis',
    readNext: 'Quels articles liés devrais-je lire ensuite, et pourquoi ?',
    overview: "Donne-moi une vue d'ensemble de ce sujet et de ses thèmes principaux",
    connect: (a, b) => `Quel est le lien entre « ${a} » et « ${b} » ?`,
    connected: 'Quels liens existent entre les articles de ce sujet ?',
    theme: (c) => `Que faut-il savoir sur « ${c} » ?`,
    readFirst: 'Quels articles de ce sujet devrais-je lire en premier, et pourquoi ?',
    fit: (x) => `Quelle place occupe ${x} dans ce sujet ?`,
    about: (x) => `Parle-moi de ${x} et de ses liens avec le reste de ce sujet.`,
  },
  es: {
    summary: 'Resume este artículo en unos pocos puntos',
    summaryOf: (t) => `Resume «${t}» en unos pocos puntos`,
    explain: (x) => `Explica la sección «${x}»`,
    meanings: (t) => `¿Qué significados de «${t}» aparecen aquí?`,
    whatIs: (x) => `¿Qué es «${x}»?`,
    section: 'Explica la sección que estoy leyendo',
    readNext: '¿Qué artículos enlazados debería leer a continuación y por qué?',
    overview: 'Dame una visión general de este tema y sus aspectos principales',
    connect: (a, b) => `¿Qué relación hay entre «${a}» y «${b}»?`,
    connected: '¿Cómo se relacionan los artículos de este tema?',
    theme: (c) => `¿Qué debería saber sobre «${c}»?`,
    readFirst: '¿Qué artículos de este tema debería leer primero y por qué?',
    fit: (x) => `¿Qué papel tiene ${x} en este tema?`,
    about: (x) => `Háblame de ${x} y de su relación con el resto de este tema.`,
  },
  it: {
    summary: 'Riassumi questo articolo in pochi punti',
    summaryOf: (t) => `Riassumi «${t}» in pochi punti`,
    explain: (x) => `Spiega la sezione «${x}»`,
    meanings: (t) => `Quali significati di «${t}» sono elencati qui?`,
    whatIs: (x) => `Che cos'è «${x}»?`,
    section: 'Spiega la sezione che sto leggendo',
    readNext: 'Quali articoli collegati dovrei leggere dopo, e perché?',
    overview: 'Dammi una panoramica di questo argomento e dei suoi temi principali',
    connect: (a, b) => `Che legame c'è tra «${a}» e «${b}»?`,
    connected: 'Come sono collegati gli articoli di questo argomento?',
    theme: (c) => `Cosa dovrei sapere su «${c}»?`,
    readFirst: 'Quali articoli di questo argomento dovrei leggere per primi, e perché?',
    fit: (x) => `Che ruolo ha ${x} in questo argomento?`,
    about: (x) => `Parlami di ${x} e di come si collega al resto di questo argomento.`,
  },
};

// Questions that fit what an article is about (its type, from Wikidata: see lib/types.js), and what a topic is
// about (its kind, from the topic-building call). Each article type has one question for any such article, then
// questions offered only when a section heading matches one of the words under `sections` (so the article can
// answer them). Words match the start of a word in the heading, case-insensitively. Names are quoted outside the
// person type so the questions read well whatever the title's grammar.
const TYPED = {
  en: {
    sections: {
      life: ['early life', 'life', 'biography', 'career', 'personal life', 'childhood'],
      legacy: ['legacy', 'influence', 'reception', 'impact', 'commemoration', 'honours', 'honors'],
      history: ['history', 'origins', 'development'],
      geography: ['geography', 'climate', 'location', 'topography'],
      culture: ['culture', 'landmarks', 'sights', 'architecture', 'tourism', 'attractions'],
      cause: ['background', 'causes', 'cause', 'prelude', 'origins'],
      aftermath: ['aftermath', 'consequences', 'impact', 'significance', 'legacy'],
      creation: ['background', 'history', 'composition', 'creation', 'writing', 'origins', 'development'],
      structure: ['structure', 'plot', 'synopsis', 'contents', 'content', 'composition', 'music', 'description'],
      reception: ['reception', 'legacy', 'influence', 'critical response'],
      beliefs: ['beliefs', 'belief', 'teachings', 'doctrine', 'theology', 'practices', 'worship', 'cult', 'mythology', 'attributes'],
      members: ['members', 'rulers', 'monarchs', 'family', 'line', 'branches', 'lineup', 'personnel', 'heads'],
      mechanism: ['mechanism', 'process', 'overview', 'principle', 'theory', 'how it works'],
      applications: ['applications', 'uses', 'significance', 'importance', 'role'],
    },
    article: {
      person: [[(t) => `What is ${t} best known for?`], [(t) => `What were the turning points in the life of ${t}?`, 'life'], [(t) => `What is the legacy of ${t}?`, 'legacy']],
      place: [[(t) => `What is “${t}” known for?`], [(t) => `How did “${t}” develop over the centuries?`, 'history'], [(t) => `What are the geography and climate of “${t}” like?`, 'geography'], [(t) => `What are the main sights and cultural highlights of “${t}”?`, 'culture']],
      event: [[(t) => `What happened in “${t}”, and why did it matter?`], [(t) => `What led to “${t}”?`, 'cause'], [(t) => `What were the consequences of “${t}”?`, 'aftermath']],
      work: [[(t) => `What is “${t}”, and what makes it notable?`], [(t) => `How did “${t}” come about?`, 'creation'], [(t) => `How is “${t}” structured?`, 'structure'], [(t) => `How was “${t}” received, then and later?`, 'reception']],
      religion: [[(t) => `What are the origins and meaning of “${t}”?`], [(t) => `What are the central beliefs and practices of “${t}”?`, 'beliefs'], [(t) => `How did “${t}” develop over time?`, 'history']],
      group: [[(t) => `How did “${t}” come about, and what is it known for?`], [(t) => `Who were the most important members of “${t}”?`, 'members'], [(t) => `How did “${t}” change over time?`, 'history']],
      concept: [[(t) => `Explain “${t}” in simple terms`], [(t) => `How does “${t}” work?`, 'mechanism'], [(t) => `Why does “${t}” matter, and where does it play a role?`, 'applications'], [(t) => `How was “${t}” discovered and developed?`, 'history']],
    },
    facts: {
      P161: (t, v) => `What role does ${v} play in “${t}”?`,
      P800: (t, v) => `Why does ${v} matter in the career of ${t}?`,
      P737: (t, v) => `How did ${v} influence ${t}?`,
      P179: (t, v) => `How does “${t}” fit into “${v}”?`,
      P155: (t, v) => `How does “${t}” follow from “${v}”?`,
      P166: (t, v) => `Why did ${t} receive “${v}”?`,
      P1411: (t, v) => `Why was ${t} nominated for “${v}”?`,
      P22: (t, v) => `How did ${v} shape the life of ${t}?`,
      P25: (t, v) => `How did ${v} shape the life of ${t}?`,
      P39: (t, v) => `What did ${t} do as ${v}?`,
      P102: (t, v) => `What was the role of ${t} in “${v}”?`,
      P54: (t, v) => `What was the role of ${t} in “${v}”?`,
      P112: (t, v) => `What was the role of ${v} in “${t}”?`,
      P127: (t, v) => `What was the role of ${v} in “${t}”?`,
    },
    topic: {
      people: 'How did these people influence each other?',
      family: 'How are the branches of this family related, and who were its key figures?',
      events: 'In what order did these events happen, and how did each lead to the next?',
      places: 'How do these places compare, and how are they connected?',
      works: 'How do these works relate to each other?',
      ideas: 'How do these ideas build on or challenge each other?',
    },
  },
  de: {
    compounds: true, // German builds long words ("Lebenslauf"), so keywords match the start of a word
    sections: {
      life: ['leben', 'biografie', 'biographie', 'werdegang', 'karriere', 'jugend', 'kindheit'],
      legacy: ['nachwirkung', 'rezeption', 'wirkung', 'vermächtnis', 'nachleben', 'ehrung', 'gedenken'],
      history: ['geschichte', 'entwicklung', 'ursprung', 'entstehung'],
      geography: ['geografie', 'geographie', 'lage$', 'klima'],
      culture: ['kultur', 'sehenswürdigkeiten', 'architektur', 'bauwerke', 'tourismus'],
      cause: ['vorgeschichte', 'hintergrund', 'ursache', 'ausgangslage'],
      aftermath: ['folgen', 'auswirkung', 'nachwirkung', 'bedeutung'],
      creation: ['entstehung', 'hintergrund', 'geschichte', 'komposition'],
      structure: ['aufbau', 'inhalt', 'handlung', 'struktur', 'gliederung', 'musik', 'besetzung'],
      reception: ['rezeption', 'wirkung', 'nachwirkung', 'aufnahme', 'kritik'],
      beliefs: ['lehre', 'glaube', 'theologie', 'praxis', 'kult$', 'mythologie', 'verehrung'],
      members: ['mitglieder', 'herrscher', 'linie', 'familie', 'stammliste', 'besetzung'],
      mechanism: ['mechanismus', 'ablauf', 'funktionsweise', 'prinzip', 'grundlagen', 'theorie'],
      applications: ['anwendung', 'bedeutung', 'verwendung', 'nutzung'],
    },
    article: {
      person: [[(t) => `Wofür ist ${t} vor allem bekannt?`], [(t) => `Was waren die Wendepunkte im Leben von ${t}?`, 'life'], [(t) => `Wie wirkt ${t} bis heute nach?`, 'legacy']],
      place: [[(t) => `Wofür ist „${t}“ bekannt?`], [(t) => `Wie hat sich „${t}“ im Lauf der Geschichte entwickelt?`, 'history'], [(t) => `Was prägt Geografie und Klima von „${t}“?`, 'geography'], [(t) => `Was sind die kulturellen Höhepunkte von „${t}“?`, 'culture']],
      event: [[(t) => `Was geschah bei „${t}“, und warum war es wichtig?`], [(t) => `Wie kam es zu „${t}“?`, 'cause'], [(t) => `Welche Folgen hatte „${t}“?`, 'aftermath']],
      work: [[(t) => `Was ist „${t}“, und was macht das Werk bedeutend?`], [(t) => `Wie ist „${t}“ entstanden?`, 'creation'], [(t) => `Wie ist „${t}“ aufgebaut?`, 'structure'], [(t) => `Wie wurde „${t}“ aufgenommen, damals und später?`, 'reception']],
      religion: [[(t) => `Was ist über Ursprung und Bedeutung von „${t}“ bekannt?`], [(t) => `Was sind die zentralen Lehren und Praktiken von „${t}“?`, 'beliefs'], [(t) => `Wie hat sich „${t}“ über die Zeit entwickelt?`, 'history']],
      group: [[(t) => `Was ist über Entstehung und Bedeutung von „${t}“ bekannt?`], [(t) => `Wer waren die wichtigsten Mitglieder von „${t}“?`, 'members'], [(t) => `Wie hat sich „${t}“ im Lauf der Zeit verändert?`, 'history']],
      concept: [[(t) => `Erkläre „${t}“ einfach und verständlich`], [(t) => `Wie funktioniert „${t}“?`, 'mechanism'], [(t) => `Wo spielt „${t}“ eine Rolle, und warum ist das wichtig?`, 'applications'], [(t) => `Wie wurde „${t}“ entdeckt und erforscht?`, 'history']],
    },
    facts: {
      P161: (t, v) => `Welche Rolle spielt ${v} in „${t}“?`,
      P800: (t, v) => `Welche Bedeutung hat ${v} für die Karriere von ${t}?`,
      P737: (t, v) => `Wie hat ${v} ${t} beeinflusst?`,
      P179: (t, v) => `Wie fügt sich „${t}“ in „${v}“ ein?`,
      P155: (t, v) => `Wie knüpft „${t}“ an „${v}“ an?`,
      P166: (t, v) => `Warum erhielt ${t} „${v}“?`,
      P1411: (t, v) => `Warum wurde ${t} für „${v}“ nominiert?`,
      P22: (t, v) => `Wie hat ${v} das Leben von ${t} geprägt?`,
      P25: (t, v) => `Wie hat ${v} das Leben von ${t} geprägt?`,
      P39: (t, v) => `Was tat ${t} als ${v}?`,
      P102: (t, v) => `Welche Rolle spielte ${t} bei „${v}“?`,
      P54: (t, v) => `Welche Rolle spielte ${t} bei „${v}“?`,
      P112: (t, v) => `Welche Rolle spielte ${v} bei „${t}“?`,
      P127: (t, v) => `Welche Rolle spielte ${v} bei „${t}“?`,
    },
    topic: {
      people: 'Wie haben sich diese Personen gegenseitig beeinflusst?',
      family: 'Wie hängen die Linien dieser Familie zusammen, und wer waren ihre wichtigsten Mitglieder?',
      events: 'In welcher Reihenfolge geschahen diese Ereignisse, und wie führte eines zum nächsten?',
      places: 'Wie unterscheiden sich diese Orte, und wie hängen sie zusammen?',
      works: 'Wie hängen diese Werke miteinander zusammen?',
      ideas: 'Wie bauen diese Ideen aufeinander auf, und wo widersprechen sie sich?',
    },
  },
  fr: {
    sections: {
      life: ['vie', 'biographie', 'carrière', 'jeunesse'],
      legacy: ['héritage', 'postérité', 'influence', 'réception', 'hommages', 'mémoire'],
      history: ['histoire', 'historique', 'origine'],
      geography: ['géographie', 'climat', 'situation', 'localisation'],
      culture: ['culture', 'patrimoine', 'monuments', 'architecture', 'tourisme'],
      cause: ['contexte', 'causes', 'origines', 'prélude'],
      aftermath: ['conséquences', 'suites', 'bilan', 'postérité'],
      creation: ['genèse', 'création', 'composition', 'contexte', 'historique'],
      structure: ['structure', 'intrigue', 'résumé', 'contenu', 'composition', 'plan'],
      reception: ['réception', 'accueil', 'postérité', 'influence'],
      beliefs: ['croyances', 'doctrine', 'théologie', 'pratiques', 'culte', 'mythologie'],
      members: ['membres', 'souverains', 'famille', 'branches', 'lignée', 'composition'],
      mechanism: ['mécanisme', 'fonctionnement', 'principe', 'processus', 'théorie'],
      applications: ['applications', 'utilisations', 'usages', 'importance', 'rôle'],
    },
    article: {
      person: [[(t) => `Qu'est-ce qui a rendu ${t} célèbre ?`], [(t) => `Quels ont été les tournants de la vie de ${t} ?`, 'life'], [(t) => `Quel est l'héritage de ${t} ?`, 'legacy']],
      place: [[(t) => `Qu'est-ce qui fait la renommée de « ${t} » ?`], [(t) => `Quelles sont les grandes étapes de l'histoire de « ${t} » ?`, 'history'], [(t) => `Quels sont la géographie et le climat de « ${t} » ?`, 'geography'], [(t) => `Quels sont les principaux monuments et atouts culturels de « ${t} » ?`, 'culture']],
      event: [[(t) => `Que s'est-il passé lors de « ${t} », et pourquoi est-ce important ?`], [(t) => `Quelles ont été les causes de « ${t} » ?`, 'cause'], [(t) => `Quelles ont été les conséquences de « ${t} » ?`, 'aftermath']],
      work: [[(t) => `Qu'est-ce que « ${t} », et qu'est-ce qui rend cette œuvre importante ?`], [(t) => `Quelle est l'histoire de la création de « ${t} » ?`, 'creation'], [(t) => `Quelle est la structure de « ${t} » ?`, 'structure'], [(t) => `Quel accueil a reçu « ${t} », à l'époque et depuis ?`, 'reception']],
      religion: [[(t) => `Que sait-on de l'origine et de la signification de « ${t} » ?`], [(t) => `Quelles sont les croyances et pratiques centrales de « ${t} » ?`, 'beliefs'], [(t) => `Quelles sont les grandes étapes de l'histoire de « ${t} » ?`, 'history']],
      group: [[(t) => `Que sait-on de l'origine et du rôle de « ${t} » ?`], [(t) => `Qui ont été les membres les plus importants de « ${t} » ?`, 'members'], [(t) => `Quelles sont les grandes étapes de l'histoire de « ${t} » ?`, 'history']],
      concept: [[(t) => `Explique « ${t} » simplement`], [(t) => `Comment fonctionne « ${t} » ?`, 'mechanism'], [(t) => `Quel est le rôle de « ${t} », et pourquoi est-ce important ?`, 'applications'], [(t) => `Quelle est l'histoire de la découverte de « ${t} » ?`, 'history']],
    },
    facts: {
      P161: (t, v) => `Quel rôle joue ${v} dans « ${t} » ?`,
      P800: (t, v) => `Quelle importance a ${v} dans la carrière de ${t} ?`,
      P737: (t, v) => `Quelle a été l'influence de ${v} sur ${t} ?`,
      P179: (t, v) => `Quelle place occupe « ${t} » dans « ${v} » ?`,
      P155: (t, v) => `Comment « ${t} » fait-il suite à « ${v} » ?`,
      P166: (t, v) => `Qu'est-ce qui a valu à ${t} de recevoir « ${v} » ?`,
      P1411: (t, v) => `Qu'est-ce qui a valu à ${t} une nomination pour « ${v} » ?`,
      P22: (t, v) => `Quelle a été l'influence de ${v} sur la vie de ${t} ?`,
      P25: (t, v) => `Quelle a été l'influence de ${v} sur la vie de ${t} ?`,
      P39: (t, v) => `Qu'a fait ${t} en tant que ${v} ?`,
      P102: (t, v) => `Quel a été le rôle de ${t} dans « ${v} » ?`,
      P54: (t, v) => `Quel a été le rôle de ${t} dans « ${v} » ?`,
      P112: (t, v) => `Quel a été le rôle de ${v} dans « ${t} » ?`,
      P127: (t, v) => `Quel a été le rôle de ${v} dans « ${t} » ?`,
    },
    topic: {
      people: 'Comment ces personnes se sont-elles influencées ?',
      family: 'Comment les branches de cette famille sont-elles liées, et qui en furent les figures clés ?',
      events: "Dans quel ordre ces événements se sont-ils produits, et comment l'un a-t-il mené au suivant ?",
      places: 'Comment ces lieux se comparent-ils, et quels liens les unissent ?',
      works: 'Quels liens unissent ces œuvres ?',
      ideas: "Comment ces idées se prolongent-elles ou s'opposent-elles ?",
    },
  },
  es: {
    sections: {
      life: ['vida', 'biografía', 'trayectoria', 'carrera', 'juventud'],
      legacy: ['legado', 'influencia', 'recepción', 'homenajes', 'reconocimientos'],
      history: ['historia', 'origen', 'desarrollo'],
      geography: ['geografía', 'clima', 'ubicación', 'localización'],
      culture: ['cultura', 'patrimonio', 'monumentos', 'arquitectura', 'turismo'],
      cause: ['antecedentes', 'causas', 'contexto', 'preludio'],
      aftermath: ['consecuencias', 'secuelas', 'repercusiones', 'legado'],
      creation: ['creación', 'composición', 'antecedentes', 'historia', 'génesis'],
      structure: ['estructura', 'argumento', 'contenido', 'sinopsis', 'composición'],
      reception: ['recepción', 'acogida', 'legado', 'influencia', 'crítica'],
      beliefs: ['creencias', 'doctrina', 'teología', 'prácticas', 'culto', 'mitología'],
      members: ['miembros', 'integrantes', 'gobernantes', 'monarcas', 'familia', 'ramas', 'linaje'],
      mechanism: ['mecanismo', 'funcionamiento', 'principio', 'proceso', 'teoría'],
      applications: ['aplicaciones', 'usos', 'importancia', 'papel'],
    },
    article: {
      person: [[(t) => `¿Por qué destaca ${t}?`], [(t) => `¿Cuáles fueron los momentos decisivos en la vida de ${t}?`, 'life'], [(t) => `¿Cuál es el legado de ${t}?`, 'legacy']],
      place: [[(t) => `¿Por qué destaca «${t}»?`], [(t) => `¿Cuáles son las grandes etapas de la historia de «${t}»?`, 'history'], [(t) => `¿Cómo son la geografía y el clima de «${t}»?`, 'geography'], [(t) => `¿Cuáles son los principales monumentos y atractivos culturales de «${t}»?`, 'culture']],
      event: [[(t) => `¿Qué ocurrió en «${t}» y por qué fue importante?`], [(t) => `¿Cuáles fueron las causas de «${t}»?`, 'cause'], [(t) => `¿Qué consecuencias tuvo «${t}»?`, 'aftermath']],
      work: [[(t) => `¿Qué es «${t}» y qué hace importante a esta obra?`], [(t) => `¿Cómo se creó «${t}»?`, 'creation'], [(t) => `¿Cuál es la estructura de «${t}»?`, 'structure'], [(t) => `¿Qué acogida tuvo «${t}», en su época y después?`, 'reception']],
      religion: [[(t) => `¿Qué se sabe del origen y el significado de «${t}»?`], [(t) => `¿Cuáles son las creencias y prácticas centrales de «${t}»?`, 'beliefs'], [(t) => `¿Cuáles son las grandes etapas de la historia de «${t}»?`, 'history']],
      group: [[(t) => `¿Qué se sabe del origen y el papel de «${t}»?`], [(t) => `¿Quiénes fueron los miembros más importantes de «${t}»?`, 'members'], [(t) => `¿Cuáles son las grandes etapas de la historia de «${t}»?`, 'history']],
      concept: [[(t) => `Explica «${t}» de forma sencilla`], [(t) => `¿Cómo funciona «${t}»?`, 'mechanism'], [(t) => `¿Qué papel tiene «${t}» y por qué es importante?`, 'applications'], [(t) => `¿Cómo se descubrió y estudió «${t}»?`, 'history']],
    },
    facts: {
      P161: (t, v) => `¿Qué papel interpreta ${v} en «${t}»?`,
      P800: (t, v) => `¿Qué importancia tiene ${v} en la carrera de ${t}?`,
      P737: (t, v) => `¿Cómo influyó ${v} en ${t}?`,
      P179: (t, v) => `¿Qué lugar ocupa «${t}» en «${v}»?`,
      P155: (t, v) => `¿Qué relación tiene «${t}» con su predecesor «${v}»?`,
      P166: (t, v) => `¿Por qué recibió ${t} «${v}»?`,
      P1411: (t, v) => `¿Qué le valió a ${t} la nominación a «${v}»?`,
      P22: (t, v) => `¿Cómo influyó ${v} en la vida de ${t}?`,
      P25: (t, v) => `¿Cómo influyó ${v} en la vida de ${t}?`,
      P39: (t, v) => `¿Qué hizo ${t} como ${v}?`,
      P102: (t, v) => `¿Qué papel tuvo ${t} en «${v}»?`,
      P54: (t, v) => `¿Qué papel tuvo ${t} en «${v}»?`,
      P112: (t, v) => `¿Qué papel tuvo ${v} en «${t}»?`,
      P127: (t, v) => `¿Qué papel tuvo ${v} en «${t}»?`,
    },
    topic: {
      people: '¿Cómo se influyeron estas personas entre sí?',
      family: '¿Cómo se relacionan las ramas de esta familia y quiénes fueron sus figuras clave?',
      events: '¿En qué orden ocurrieron estos acontecimientos y cómo llevó cada uno al siguiente?',
      places: '¿Cómo se comparan estos lugares y qué los conecta?',
      works: '¿Qué relación hay entre estas obras?',
      ideas: '¿Cómo se complementan o se contradicen estas ideas?',
    },
  },
  it: {
    sections: {
      life: ['vita', 'biografia', 'carriera', 'giovinezza'],
      legacy: ['eredità', 'influenza', 'ricezione', 'fortuna', 'onorificenze', 'memoria'],
      history: ['storia', 'origini', 'sviluppo'],
      geography: ['geografia', 'clima', 'territorio', 'posizione'],
      culture: ['cultura', 'monumenti', 'architettura', 'turismo', 'patrimonio'],
      cause: ['antefatti', 'cause', 'contesto', 'premesse'],
      aftermath: ['conseguenze', 'esiti', 'eredità'],
      creation: ['genesi', 'composizione', 'storia', 'creazione', 'contesto'],
      structure: ['struttura', 'trama', 'contenuto', 'sinossi', 'composizione'],
      reception: ['ricezione', 'accoglienza', 'fortuna', 'influenza', 'critica'],
      beliefs: ['credenze', 'dottrina', 'teologia', 'pratiche', 'culto', 'mitologia'],
      members: ['membri', 'componenti', 'sovrani', 'famiglia', 'rami', 'formazione'],
      mechanism: ['meccanismo', 'funzionamento', 'principio', 'processo', 'teoria'],
      applications: ['applicazioni', 'usi', 'importanza', 'ruolo'],
    },
    article: {
      person: [[(t) => `Per che cosa si ricorda soprattutto ${t}?`], [(t) => `Quali sono state le svolte nella vita di ${t}?`, 'life'], [(t) => `Qual è l'eredità di ${t}?`, 'legacy']],
      place: [[(t) => `Che cosa rende celebre «${t}»?`], [(t) => `Quali sono le tappe principali della storia di «${t}»?`, 'history'], [(t) => `Come sono la geografia e il clima di «${t}»?`, 'geography'], [(t) => `Quali sono i principali monumenti e le attrattive culturali di «${t}»?`, 'culture']],
      event: [[(t) => `Che cosa accadde in «${t}» e perché fu importante?`], [(t) => `Quali furono le cause di «${t}»?`, 'cause'], [(t) => `Quali conseguenze ebbe «${t}»?`, 'aftermath']],
      work: [[(t) => `Che cos'è «${t}» e che cosa rende importante quest'opera?`], [(t) => `Qual è la storia della creazione di «${t}»?`, 'creation'], [(t) => `Qual è la struttura di «${t}»?`, 'structure'], [(t) => `Che accoglienza ebbe «${t}», all'epoca e in seguito?`, 'reception']],
      religion: [[(t) => `Che cosa si sa dell'origine e del significato di «${t}»?`], [(t) => `Quali sono le credenze e le pratiche centrali di «${t}»?`, 'beliefs'], [(t) => `Quali sono le tappe principali della storia di «${t}»?`, 'history']],
      group: [[(t) => `Che cosa si sa dell'origine e del ruolo di «${t}»?`], [(t) => `Chi furono i membri più importanti di «${t}»?`, 'members'], [(t) => `Quali sono le tappe principali della storia di «${t}»?`, 'history']],
      concept: [[(t) => `Spiega «${t}» in modo semplice`], [(t) => `Come funziona «${t}»?`, 'mechanism'], [(t) => `Che ruolo ha «${t}» e perché è importante?`, 'applications'], [(t) => `Qual è la storia della scoperta di «${t}»?`, 'history']],
    },
    facts: {
      P161: (t, v) => `Che ruolo interpreta ${v} in «${t}»?`,
      P800: (t, v) => `Che importanza ha ${v} nella carriera di ${t}?`,
      P737: (t, v) => `In che modo ${v} ha influenzato ${t}?`,
      P179: (t, v) => `Che posto occupa «${t}» in «${v}»?`,
      P155: (t, v) => `Che rapporto c'è tra «${t}» e il precedente «${v}»?`,
      P166: (t, v) => `Perché ${t} ha ricevuto «${v}»?`,
      P1411: (t, v) => `Che cosa ha valso a ${t} la candidatura a «${v}»?`,
      P22: (t, v) => `In che modo ${v} ha segnato la vita di ${t}?`,
      P25: (t, v) => `In che modo ${v} ha segnato la vita di ${t}?`,
      P39: (t, v) => `Che cosa ha fatto ${t} come ${v}?`,
      P102: (t, v) => `Che ruolo ha avuto ${t} in «${v}»?`,
      P54: (t, v) => `Che ruolo ha avuto ${t} in «${v}»?`,
      P112: (t, v) => `Che ruolo ha avuto ${v} in «${t}»?`,
      P127: (t, v) => `Che ruolo ha avuto ${v} in «${t}»?`,
    },
    topic: {
      people: 'Come si sono influenzate a vicenda queste persone?',
      family: 'Come sono legati i rami di questa famiglia e chi ne furono le figure chiave?',
      events: 'In che ordine si sono svolti questi eventi e come ognuno ha portato al successivo?',
      places: 'Come si confrontano questi luoghi e che cosa li collega?',
      works: "Che rapporto c'è tra queste opere?",
      ideas: 'Come si sviluppano o si contraddicono queste idee?',
    },
  },
};

// Sections about what a subject left behind or did to the world, rather than what it was.
const OUTWARD = new Set(['legacy', 'aftermath', 'reception', 'applications']);

// A pattern for a section's keywords: whole words with an optional plural, so "life" doesn't match "Lifestyle" or
// "cult" "Culture". In a language with `compounds`, the start of a word, unless the keyword ends in $.
function sectionPattern(words, compounds) {
  const end = '(?:e?s)?(?![\\p{L}\\p{N}])';
  const alternatives = words.map((w) => {
    const whole = !compounds || w.endsWith('$');
    return w.replace(/\$$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (whole ? end : '');
  });
  return new RegExp(`(^|[^\\p{L}])(${alternatives.join('|')})`, 'iu');
}

// Up to `max` questions for an article of this type, only those a section can answer: the general one first, and
// one about the subject's effect on the world if there is one, so that they don't cover the same ground.
function typedQuestions(code, type, title, headings, max = 2) {
  const book = TYPED[code] || TYPED.en;
  const list = book.article[type];
  if (!list) return [];
  const has = (key) => {
    const re = sectionPattern(book.sections[key] || [], book.compounds);
    return headings.some((h) => re.test(h));
  };
  const fitting = list.filter(([, needs]) => !needs || has(needs));
  const first = fitting.slice(0, max);
  const outward = fitting.find(([, needs]) => OUTWARD.has(needs));
  const picked = outward && !first.includes(outward) ? [...first.slice(0, max - 1), outward] : first;
  return picked.map(([q]) => q(title));
}

// A question built on a fact from Wikidata, about whichever fact the article's text names most, or ''. A fact the
// text doesn't name is left out: Wikidata can say things an article doesn't, and the answers come from the article.
// That the text names it doesn't prove the fact, so a question can still be answered with a correction.
function factQuestion(code, { title, facts, text, links = [] }) {
  const templates = (TYPED[code] || TYPED.en).facts;
  const short = (t) => t.replace(/ \([^)]*\)$/, '');
  const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const known = Object.keys(templates);
  let best = null;
  let most = 0;
  for (const fact of [...facts].sort((a, b) => known.indexOf(a.property) - known.indexOf(b.property))) {
    if (!templates[fact.property] || fact.title === title) continue;
    const link = links.find((l) => l.title === fact.title);
    const names = [...new Set([short(fact.title), ...(link?.anchors || [])])].filter((n) => n.length > 2);
    if (!names.length) continue;
    const mentions = text.match(new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'gu'))?.length || 0;
    if (mentions > most) {
      most = mentions;
      best = fact;
    }
  }
  if (!best) return '';
  // "I, Robot (film)" and "I, Robot" need their brackets to be told apart.
  const same = short(best.title) === short(title);
  return templates[best.property](same ? title : short(title), same ? best.title : short(best.title));
}

// Starter questions for an article, from what the page shows: its name, its sections (without back matter), the
// section being read if any, its links with how often each is mentioned, the kind of subject once known, and a
// question built on a fact, which goes second. Stubs get fewer; a disambiguation page asks which meaning.
function starterQuestions(code, { title, type, sections, reading, links, disambiguation, fact = '' }) {
  const p = PHRASES[code] || PHRASES.en;
  if (disambiguation) return [p.meanings(title), ...links.slice(0, 2).map((l) => p.whatIs(l.title))];
  if (!sections.length) return [p.summaryOf(title), p.readNext];
  const typed = typedQuestions(code, type, title, sections);
  if (typed.length) return [typed[0], ...(fact ? [fact] : typed.slice(1)), reading ? p.explain(reading) : p.summaryOf(title)];
  if (fact) return [p.summaryOf(title), fact, reading ? p.explain(reading) : p.readNext];
  const top = [...links].sort((a, b) => b.count - a.count)[0];
  return [p.summaryOf(title), reading ? p.explain(reading) : top ? p.connect(title, top.title) : p.section, p.readNext];
}

// Starter questions for a topic chat. `themes` are the names of its themes that have articles; `here` is the article
// on screen, or nothing when it's the one the topic is about.
function topicQuestions(code, { kind, themes, here }) {
  const p = PHRASES[code] || PHRASES.en;
  const [a, b, c] = themes;
  // A question that fits what the topic is about (its people, events, works …) takes the third theme's place.
  const fitting = topicQuestion(code, kind);
  return [
    p.overview,
    fitting || null,
    a && b ? p.connect(a, b) : p.connected,
    !fitting && c ? p.theme(c) : null,
    here ? p.fit(here) : p.readFirst,
  ].filter(Boolean);
}

// The question that fits a topic's kind ('people', 'family', 'events', 'places', 'works', 'ideas'), or ''.
const topicQuestion = (code, kind) => (TYPED[code] || TYPED.en).topic[kind] || '';

export const phraseBook = { get: (code) => PHRASES[code] || PHRASES.en, typedQuestions, topicQuestion, factQuestion, starterQuestions, topicQuestions, TYPED };
