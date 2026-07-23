import type { Rng } from '@anywhererace/core';

/**
 * Names for a randomised field.
 *
 * The pool is a set of naming traditions, and a racer's given and family name
 * are always drawn from the *same* one. That pairing rule is the whole point:
 * a generator that stitches a given name from one culture onto a surname from
 * another produces names that read as nonsense to anyone who knows either, so
 * the two halves are never crossed. A field ends up an international mix because
 * a tradition is picked afresh per racer, not once for the whole grid — which is
 * also why no single culture is ever quietly assumed for everyone.
 *
 * Every name is in a plain ASCII romanisation — Garcia not García, Mueller not
 * Müller, Nguyen not Nguyễn, Minjun not Min-jun. That is partly because the
 * timing tower and marker labels are laid out for unaccented Latin text, and
 * partly a hard contract: the tests require `First Last` with ASCII letters
 * only, so anything with a diacritic, hyphen or apostrophe would fail. For the
 * same reason, traditions whose surname changes with the bearer's gender
 * (Slavic -ski/-ska, Icelandic patronymics) are left out unless the surname
 * form is genuinely invariant — the field has no gender for a surname to agree
 * with, so only names that pair correctly regardless are included.
 *
 * These are ordinary, common names, not real individuals; a chance collision
 * with a real person is possible but never aimed for.
 *
 * Drawn from the race's seeded RNG, so "randomise the field" is reproducible
 * from the seed like everything else.
 */

export type NameGroup = {
  /** The naming tradition, for documentation and any future "origin" UI. */
  label: string;
  given: readonly string[];
  family: readonly string[];
};

/**
 * Exported so a test can check every token directly: the marker labels and the
 * name-shape contract both require plain ASCII `First Last`, and a single missed
 * diacritic anywhere in the pool would only surface as a rare, seed-dependent
 * failure otherwise.
 */
export const NAME_GROUPS: readonly NameGroup[] = [
  {
    // Keeps the invented-but-Anglophone flavour the generator shipped with.
    label: 'Anglophone',
    given: [
      'Ash', 'Bex', 'Cole', 'Dana', 'Elliot', 'Faye', 'Gale', 'Hollis', 'Iris', 'Jory',
      'Kit', 'Logan', 'Mara', 'Nolan', 'Piper', 'Reese', 'Sloane', 'Tate', 'Wren', 'Blake',
    ],
    family: [
      'Ashby', 'Barrow', 'Calder', 'Drake', 'Ellery', 'Fairhurst', 'Grimm', 'Hale', 'Larkin',
      'Mercer', 'Nash', 'Pike', 'Roscoe', 'Sable', 'Thorn', 'Vance', 'Wexler', 'Yates',
    ],
  },
  {
    label: 'Spanish / Latin American',
    given: [
      'Mateo', 'Sofia', 'Diego', 'Lucia', 'Javier', 'Camila', 'Andres', 'Valentina', 'Carlos',
      'Elena', 'Pablo', 'Marina', 'Hugo', 'Paula', 'Ramiro', 'Bruno',
    ],
    family: [
      'Garcia', 'Fernandez', 'Ramirez', 'Torres', 'Morales', 'Herrera', 'Castro', 'Vega', 'Rios',
      'Navarro', 'Molina', 'Guerrero', 'Delgado', 'Campos', 'Reyes', 'Ibarra',
    ],
  },
  {
    label: 'Italian',
    given: [
      'Luca', 'Giulia', 'Marco', 'Chiara', 'Matteo', 'Alessia', 'Lorenzo', 'Sara', 'Davide',
      'Bianca', 'Nico', 'Aurora', 'Stefano', 'Greta', 'Enzo', 'Pietro',
    ],
    family: [
      'Romano', 'Ricci', 'Marino', 'Greco', 'Bruno', 'Costa', 'Rizzo', 'Ferrari', 'Conti',
      'Gallo', 'Fontana', 'Barbieri', 'Moretti', 'Longo', 'Serra', 'Villa',
    ],
  },
  {
    label: 'French',
    given: [
      'Louis', 'Camille', 'Hugo', 'Manon', 'Julien', 'Chloe', 'Antoine', 'Elise', 'Remy',
      'Adele', 'Theo', 'Margaux', 'Bastien', 'Colette', 'Damien', 'Noemie',
    ],
    family: [
      'Moreau', 'Laurent', 'Bernard', 'Dubois', 'Lambert', 'Fournier', 'Girard', 'Roux', 'Blanc',
      'Mercier', 'Faure', 'Renard', 'Colin', 'Petit', 'Marchand', 'Perrin',
    ],
  },
  {
    label: 'German',
    given: [
      'Lukas', 'Anna', 'Felix', 'Lena', 'Jonas', 'Klara', 'Maximilian', 'Frieda', 'Niklas',
      'Johanna', 'Elias', 'Marlene', 'Moritz', 'Paula', 'Tobias', 'Greta',
    ],
    family: [
      'Weber', 'Schneider', 'Fischer', 'Wagner', 'Becker', 'Hoffmann', 'Schafer', 'Koch', 'Bauer',
      'Richter', 'Klein', 'Wolf', 'Neumann', 'Braun', 'Krause', 'Mueller',
    ],
  },
  {
    label: 'Nordic',
    given: [
      'Erik', 'Astrid', 'Lars', 'Ingrid', 'Nils', 'Freya', 'Emil', 'Sigrid', 'Magnus', 'Elin',
      'Anders', 'Maja', 'Henrik', 'Sofie', 'Kasper', 'Linnea',
    ],
    family: [
      'Larsen', 'Hansen', 'Berg', 'Lindqvist', 'Dahl', 'Nyberg', 'Halvorsen', 'Sundberg',
      'Ekstrom', 'Moller', 'Holm', 'Vik', 'Lund', 'Strand', 'Bakke', 'Sandberg',
    ],
  },
  {
    label: 'Japanese',
    given: [
      'Haruki', 'Yuki', 'Sora', 'Aoi', 'Ren', 'Hina', 'Kaito', 'Mei', 'Riku', 'Sakura',
      'Takumi', 'Yui', 'Daichi', 'Rina', 'Kenji', 'Nao',
    ],
    family: [
      'Tanaka', 'Sato', 'Suzuki', 'Takahashi', 'Watanabe', 'Ito', 'Yamamoto', 'Nakamura',
      'Kobayashi', 'Kato', 'Yoshida', 'Yamada', 'Sasaki', 'Matsumoto', 'Inoue', 'Kimura',
    ],
  },
  {
    label: 'Korean',
    given: [
      'Minjun', 'Seoyeon', 'Jiho', 'Hana', 'Doyun', 'Yuna', 'Jimin', 'Areum', 'Siwoo', 'Nari',
      'Junseo', 'Sena', 'Hyun', 'Bora', 'Woojin', 'Suah',
    ],
    family: [
      'Kim', 'Lee', 'Park', 'Choi', 'Jung', 'Kang', 'Cho', 'Yoon', 'Jang', 'Lim', 'Han', 'Oh',
      'Seo', 'Shin', 'Kwon', 'Song',
    ],
  },
  {
    label: 'Chinese',
    given: [
      'Wei', 'Fang', 'Jun', 'Ling', 'Hao', 'Mei', 'Lei', 'Yan', 'Bo', 'Xia', 'Feng', 'Hui',
      'Tao', 'Jing', 'Peng', 'Na',
    ],
    family: [
      'Chen', 'Wang', 'Li', 'Zhang', 'Liu', 'Yang', 'Huang', 'Zhao', 'Wu', 'Zhou', 'Xu', 'Sun',
      'Ma', 'Lin', 'Guo', 'He',
    ],
  },
  {
    label: 'Vietnamese',
    given: [
      'Minh', 'Anh', 'Linh', 'Huy', 'Thao', 'Nam', 'Mai', 'Quan', 'Trang', 'Duc', 'Lan', 'Khanh',
      'Ngan', 'Phuc', 'Thu', 'Bao',
    ],
    family: [
      'Nguyen', 'Tran', 'Le', 'Pham', 'Hoang', 'Vu', 'Dang', 'Bui', 'Do', 'Ho', 'Ngo', 'Duong',
      'Ly', 'Vo', 'Phan', 'Dinh',
    ],
  },
  {
    label: 'Arabic',
    given: [
      'Omar', 'Layla', 'Yusuf', 'Amira', 'Karim', 'Nadia', 'Tariq', 'Salma', 'Bilal', 'Yasmin',
      'Samir', 'Rania', 'Zaid', 'Huda', 'Nabil', 'Farah',
    ],
    family: [
      'Hassan', 'Ali', 'Ibrahim', 'Khalil', 'Mansour', 'Saleh', 'Nasser', 'Rahman', 'Aziz',
      'Haddad', 'Najjar', 'Farouk', 'Sabbagh', 'Karam', 'Zaidan', 'Rashid',
    ],
  },
  {
    label: 'South Asian',
    given: [
      'Arjun', 'Priya', 'Rohan', 'Ananya', 'Vikram', 'Neha', 'Aditya', 'Isha', 'Kiran', 'Divya',
      'Rahul', 'Meera', 'Sanjay', 'Pooja', 'Nikhil', 'Anjali',
    ],
    family: [
      'Sharma', 'Patel', 'Singh', 'Kumar', 'Reddy', 'Nair', 'Iyer', 'Gupta', 'Mehta', 'Rao',
      'Bose', 'Chopra', 'Malhotra', 'Desai', 'Verma', 'Kapoor',
    ],
  },
  {
    label: 'West African',
    given: [
      'Ade', 'Femi', 'Bola', 'Chidi', 'Ngozi', 'Emeka', 'Amara', 'Kunle', 'Ife', 'Tunde', 'Zola',
      'Sade', 'Obi', 'Yemi', 'Dayo', 'Nia',
    ],
    family: [
      'Adeyemi', 'Okafor', 'Balogun', 'Okonkwo', 'Adebayo', 'Nwosu', 'Oyelaran', 'Afolabi', 'Eze',
      'Bello', 'Ojo', 'Diallo', 'Mensah', 'Owusu', 'Danso', 'Sowande',
    ],
  },
  {
    label: 'Greek',
    given: [
      'Nikos', 'Eleni', 'Yannis', 'Sofia', 'Dimitris', 'Maria', 'Kostas', 'Katerina', 'Petros',
      'Ariadne', 'Stavros', 'Zoe', 'Thanos', 'Despina', 'Vasilis', 'Ioanna',
    ],
    family: [
      'Papadopoulos', 'Nikolaou', 'Georgiou', 'Vlachos', 'Katsaros', 'Andreou', 'Makris',
      'Christodoulou', 'Samaras', 'Fotopoulos', 'Dimitriou', 'Pappas', 'Roussos', 'Stavrou',
      'Antoniou', 'Manos',
    ],
  },
  {
    label: 'Turkish',
    given: [
      'Emre', 'Elif', 'Deniz', 'Cem', 'Aylin', 'Baris', 'Ceren', 'Kaan', 'Selin', 'Burak', 'Ece',
      'Ozan', 'Derya', 'Tolga', 'Nur', 'Kerem',
    ],
    family: [
      'Yilmaz', 'Demir', 'Kaya', 'Sahin', 'Celik', 'Aydin', 'Ozturk', 'Arslan', 'Dogan', 'Kilic',
      'Aslan', 'Cetin', 'Korkmaz', 'Polat', 'Erdem', 'Yildiz',
    ],
  },
  {
    // Polish. Only surnames that do not decline for the bearer's gender are
    // used, so any given name here pairs correctly — "Ewa Nowak" and "Piotr
    // Nowak" are both right, where "Ewa Kowalski" would not be.
    label: 'Polish',
    given: [
      'Piotr', 'Ewa', 'Jakub', 'Zofia', 'Marek', 'Ola', 'Tomasz', 'Ania', 'Kamil', 'Kasia',
      'Bartek', 'Magda', 'Rafal', 'Iga', 'Darek', 'Lena',
    ],
    family: [
      'Nowak', 'Kowalczyk', 'Wojcik', 'Mazur', 'Krawczyk', 'Kaczmarek', 'Wieczorek', 'Baran',
      'Duda', 'Kubiak', 'Zajac', 'Sikora', 'Sowa', 'Kula', 'Bak', 'Kmiec',
    ],
  },
];

/**
 * `count` distinct names. Distinct matters more than it looks: two racers
 * called the same thing makes the timing tower unreadable, which is the one
 * place a viewer looks to work out who is winning.
 */
export const generateRacerNames = (count: number, rng: Rng): string[] => {
  const used = new Set<string>();
  const names: string[] = [];

  for (let i = 0; i < count; i++) {
    let name = '';
    // Thousands of within-tradition combinations across the groups, so a
    // collision is unlikely even at a full grid — but "unlikely" is not "never"
    // and the numbered fallback keeps a crowded field deterministic and distinct.
    for (let attempt = 0; attempt < 16 && (name === '' || used.has(name)); attempt++) {
      const group = rng.pick(NAME_GROUPS);
      name = `${rng.pick(group.given)} ${rng.pick(group.family)}`;
    }
    if (used.has(name)) name = `${name} ${i + 1}`;
    used.add(name);
    names.push(name);
  }
  return names;
};
