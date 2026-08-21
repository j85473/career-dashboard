export const NON_ENGLISH_JOB_INFO_REASON = 'Available job information is not in English.';

export type JobLanguageAssessment = {
  isAffirmativelyNonEnglish: boolean;
  reason: string | null;
};

type LanguageProfile = {
  markers: ReadonlySet<string>;
};

const ENGLISH_MARKERS = new Set([
  'a', 'about', 'and', 'are', 'as', 'at', 'be', 'for', 'from', 'has', 'have',
  'in', 'is', 'job', 'of', 'or', 'our', 'position', 'qualifications', 'required',
  'requirements', 'responsibilities', 'role', 'sales', 'team', 'that', 'the',
  'this', 'to', 'we', 'will', 'with', 'work', 'you', 'your',
]);

// Function words plus job-posting vocabulary give a much safer signal than
// accents or isolated words. Profiles stay separate so an English posting
// listing several desired languages cannot accidentally accumulate evidence.
const LANGUAGE_PROFILES: readonly LanguageProfile[] = [
  {
    markers: new Set([
      'au', 'aux', 'avec', 'candidat', 'candidature', 'compétences', 'dans',
      'des', 'du', 'emploi', 'en', 'est', 'et', 'expérience', 'la', 'le', 'les',
      'missions', 'notre', 'nous', 'poste', 'pour', 'responsabilités', 'serez',
      'sommes', 'sont', 'travail', 'une', 'votre', 'vous', 'équipe',
    ]),
  },
  {
    markers: new Set([
      'años', 'buscamos', 'candidato', 'clientes', 'con', 'del', 'el', 'empleo',
      'equipo', 'es', 'experiencia', 'habilidades', 'la', 'las', 'los', 'nuestra',
      'nuestro', 'para', 'puesto', 'requisitos', 'responsabilidades', 'será',
      'son', 'sus', 'trabajo', 'usted', 'ustedes', 'ventas',
    ]),
  },
  {
    markers: new Set([
      'als', 'anforderungen', 'aufgaben', 'bewerben', 'bewerbung', 'der', 'die',
      'ein', 'eine', 'erfahrung', 'für', 'ihre', 'ist', 'kunden', 'mit', 'sie',
      'sind', 'stelle', 'und', 'unser', 'vertrieb', 'von', 'werden', 'wir', 'zum',
      'zur',
    ]),
  },
  {
    markers: new Set([
      'baan', 'de', 'een', 'en', 'ervaring', 'functie', 'het', 'jij', 'jouw',
      'klanten', 'met', 'naar', 'onze', 'solliciteren', 'van', 'vereisten', 'voor',
      'verantwoordelijkheden', 'verkoop', 'werkzaamheden', 'wij', 'zijn',
    ]),
  },
  {
    markers: new Set([
      'candidato', 'clientes', 'com', 'da', 'das', 'de', 'do', 'dos', 'e',
      'equipe', 'experiência', 'nosso', 'nossa', 'para', 'requisitos',
      'responsabilidades', 'seu', 'sua', 'trabalho', 'uma', 'vaga', 'vendas',
      'você',
    ]),
  },
  {
    markers: new Set([
      'anni', 'candidato', 'clienti', 'competenze', 'con', 'esperienza', 'il',
      'la', 'le', 'lavoro', 'nostro', 'per', 'posizione', 'requisiti',
      'responsabilità', 'ricerchiamo', 'ruolo', 'sarà', 'sono', 'squadra', 'vendite',
    ]),
  },
  {
    markers: new Set([
      'ansvar', 'arbetsuppgifter', 'arbete', 'din', 'dina', 'du', 'en', 'erfarenhet',
      'ett', 'för', 'krav', 'med', 'och', 'rollen', 'som', 'tjänsten', 'vi', 'vår',
    ]),
  },
  {
    markers: new Set([
      'ansvar', 'arbeid', 'arbeidsoppgaver', 'din', 'dine', 'du', 'en', 'erfaring',
      'et', 'for', 'krav', 'med', 'og', 'rollen', 'som', 'stillingen', 'vi', 'vår',
    ]),
  },
  {
    markers: new Set([
      'ansvar', 'arbejde', 'arbejdsopgaver', 'din', 'dine', 'du', 'en', 'erfaring',
      'et', 'for', 'krav', 'med', 'og', 'rollen', 'som', 'stillingen', 'vi', 'vores',
    ]),
  },
  {
    // Finnish. Not Indo-European, so it shares no vocabulary with the other
    // profiles above, and its diacritics (ä/ö) are still Latin script, so the
    // non-Latin-script check below cannot catch it either — a genuinely
    // Finnish posting had nothing else to flag it. See job e4045272 (all-Finnish
    // description, English-looking title) for the real posting this missed.
    markers: new Set([
      'ei', 'edut', 'erikoisosaaminen', 'etsimme', 'haemme', 'hakemus', 'hakija',
      'joka', 'kanssa', 'kokemus', 'me', 'meillä', 'myyjä', 'myynti', 'olisitko',
      'osaaminen', 'palkka', 'palvelu', 'sinä', 'tehtävä', 'tehtävät', 'tiimi',
      'työ', 'työntekijä', 'vaatimukset', 'yritys', 'asiakas', 'asiakkaat', 'että',
    ]),
  },
];

const DEFINITELY_NON_ENGLISH_TITLE = /\b(?:accountmanager\s+buitendienst|außendienstmitarbeiter|charg[ée]e?\s+de\s+comptes|chef\s+des\s+ventes|directeur\s+commercial|direttore\s+commerciale|ejecutivo\s+de\s+cuentas|gerente\s+(?:comercial|de\s+ventas|de\s+cuentas)|geschäftsführer|jefe\s+de\s+ventas|kundenberater|responsable\s+(?:commercial|des\s+ventes|de\s+comptes)|responsabile\s+commerciale|verkaufsleiter|vertriebsleiter|werkstudent)\b/iu;

const NON_LATIN_SCRIPT = /[\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Arabic}\p{Script=Hangul}\p{Script=Greek}\p{Script=Hebrew}]/gu;
const LETTER = /\p{L}/gu;
const WORD = /\p{L}+/gu;
// A page scraped as markdown (unresolved portal chrome, nav menus, image alt
// text) embeds many raw URLs. Hostnames split on hyphens or dots tokenize
// into ordinary-looking words — "fujifilm-com" -> "fujifilm", "com" — and a
// domain fragment like ".com"/".de"/".do" is exactly a marker word in one of
// the profiles below. Observed for real on job 44126b11 (Fujifilm) and
// af5129cb (Honeywell): both are English postings whose scraped page had
// enough URLs to trip the Portuguese profile on "com"/"de"/"do" alone. Strip
// URL-shaped substrings before any language evidence is counted.
const URL_LIKE = /(?:https?:\/\/|www\.)\S+/gi;

function countMarkers(tokens: readonly string[], markers: ReadonlySet<string>): { hits: number; distinct: number } {
  let hits = 0;
  const distinct = new Set<string>();
  for (const token of tokens) {
    if (!markers.has(token)) continue;
    hits += 1;
    distinct.add(token);
  }
  return { hits, distinct: distinct.size };
}

/**
 * Returns true only when the title/description contain affirmative language
 * evidence. Ambiguous or sparse Latin-script metadata intentionally fails
 * open so names, locations, acronyms, and language requirements are not used
 * as a dismissal signal.
 */
export function assessJobInfoLanguage(input: {
  title?: string | null;
  description?: string | null;
}): JobLanguageAssessment {
  const title = (input.title || '').normalize('NFKC').trim();
  const description = (input.description || '').normalize('NFKC').trim();
  const combined = `${title}\n${description}`.trim();

  if (!combined) return { isAffirmativelyNonEnglish: false, reason: null };

  const withoutUrls = combined.replace(URL_LIKE, ' ');
  const tokens = (withoutUrls.toLocaleLowerCase('en-US').match(WORD) || []);
  const english = countMarkers(tokens, ENGLISH_MARKERS);
  const letters = withoutUrls.match(LETTER) || [];
  const nonLatinLetters = withoutUrls.match(NON_LATIN_SCRIPT) || [];
  const nonLatinRatio = nonLatinLetters.length / Math.max(letters.length, 1);
  if (
    nonLatinLetters.length >= 6
    && (nonLatinRatio >= 0.65 || (nonLatinRatio >= 0.3 && english.hits < 4))
  ) {
    return { isAffirmativelyNonEnglish: true, reason: NON_ENGLISH_JOB_INFO_REASON };
  }

  if (DEFINITELY_NON_ENGLISH_TITLE.test(title)) {
    return { isAffirmativelyNonEnglish: true, reason: NON_ENGLISH_JOB_INFO_REASON };
  }

  if (tokens.length < 8) return { isAffirmativelyNonEnglish: false, reason: null };

  for (const profile of LANGUAGE_PROFILES) {
    const foreign = countMarkers(tokens, profile.markers);
    if (
      foreign.hits >= 5
      && foreign.distinct >= 3
      && foreign.hits >= Math.max(english.hits * 1.25, english.hits + 2)
    ) {
      return { isAffirmativelyNonEnglish: true, reason: NON_ENGLISH_JOB_INFO_REASON };
    }
  }

  return { isAffirmativelyNonEnglish: false, reason: null };
}
