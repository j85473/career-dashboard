import assert from 'node:assert/strict';
import test from 'node:test';

import { assessJobInfoLanguage } from '../jobLanguage';

test('a genuinely Finnish posting is caught even with an English-looking title', () => {
  // Real posting (job e4045272) that reached Aim scoring before this profile
  // existed: Latin script (so the non-Latin-script check cannot catch it),
  // and the title mixes in "Sales Manager", so the foreign-title regex misses
  // it too. Only a Finnish vocabulary profile catches this.
  const result = assessJobInfoLanguage({
    title: 'Sales Manager, Biisoni Business & Technology Oy',
    description: 'Biisoni on täyden palvelun henkilöstöpalvelutalo, joka on keskittynyt '
      + 'täyttämään asiakkaidensa henkilöstötarpeet löytämällä yritykselle parhaat tekijät. '
      + 'Meillä tutkitusti viihdytään. Olisitko sinä Tampereen toimipisteemme uusi Sales Manager? '
      + 'Haemme laumaamme ratkaisumyyjää uusiin tehtäviin.',
  });
  assert.equal(result.isAffirmativelyNonEnglish, true);
});

test('ordinary English sales postings are never flagged', () => {
  const samples = [
    {
      title: 'Account Executive',
      description: 'We are looking for an experienced Account Executive to join our sales '
        + 'team. You will manage a portfolio of clients and drive new business. Requirements: '
        + '3+ years of B2B sales experience, strong communication skills, and a track record of '
        + 'exceeding quota. This is a great opportunity to grow your career with our company.',
    },
    {
      title: 'Territory Sales Manager',
      description: 'The Territory Sales Manager is responsible for managing customer '
        + 'relationships and achieving sales targets within an assigned region. We offer a '
        + 'competitive salary, benefits, and a supportive team environment.',
    },
  ];
  for (const sample of samples) {
    assert.equal(assessJobInfoLanguage(sample).isAffirmativelyNonEnglish, false, sample.title);
  }
});

test('sparse or empty metadata fails open rather than flagging', () => {
  assert.equal(assessJobInfoLanguage({ title: null, description: null }).isAffirmativelyNonEnglish, false);
  assert.equal(assessJobInfoLanguage({ title: 'Account Manager', description: '' }).isAffirmativelyNonEnglish, false);
});

test('a scraped page full of URLs is never flagged on domain-fragment coincidence', () => {
  // Real postings: unresolved portal chrome scraped as markdown instead of the
  // actual job description, containing dozens of nav-menu links. Hostnames
  // split on hyphens/dots tokenize into ordinary words — "fujifilm-com" ->
  // "fujifilm", "com" — and ".com"/".de"/".do" happen to be Portuguese
  // markers. One of these (af5129cb) is a job Joseph already applied to.
  const scrapedPortalChrome = {
    title: 'Sr Account Manager-warehouse automation (Northeast)',
    description: `Title: Sr Account Manager-warehouse automation (Northeast)

URL Source: https://careers.honeywell.com/en/sites/Honeywell/job/149124/

[Skip to main content.](https://careers.honeywell.com/en/sites/Honeywell#main)

[![Image: Logo](https://www.honeywell.com/content/dam/honeywellbt/en/images/logos/honeywell-logo.svg)](https://www.honeywell.com/us/en)

* [Honeywell Forge](https://www.honeywell.com/en-us/honeywell-forge/our-solutions)
* [Industries](https://www.honeywell.com/en-us/industries/overview)
* [Company](https://www.honeywell.com/en-us/company/about-us)
* [![fujifilm logo](https://c-8725-20200630-www-fujifilm-com.i.icims.com/us/en)United States](https://c-8725-20200630-www-fujifilm-com.i.icims.com/us/en)
* [Data Storage](https://c-8725-20200630-www-fujifilm-com.i.icims.com/us/en/business/data-storage?category=8)

We are seeking an experienced Account Manager to join our warehouse automation team. You will be responsible for driving sales and managing key customer relationships across the Northeast region.`,
  };
  assert.equal(assessJobInfoLanguage(scrapedPortalChrome).isAffirmativelyNonEnglish, false);
});

test('existing non-Finnish language profiles still detect their language', () => {
  const french = assessJobInfoLanguage({
    title: 'Responsable Commercial',
    description: 'Nous recherchons un candidat avec de l\'expérience pour rejoindre notre '
      + 'équipe. Vous serez responsable des missions et des responsabilités liées au poste. '
      + 'Le candidat idéal aura des compétences en vente et sera à l\'aise avec nos clients.',
  });
  assert.equal(french.isAffirmativelyNonEnglish, true);

  const german = assessJobInfoLanguage({
    title: 'Vertriebsleiter',
    description: 'Wir suchen für unser Team eine erfahrene Person mit Erfahrung im Vertrieb. '
      + 'Ihre Aufgaben sind vielfältig und Sie sind für unsere Kunden verantwortlich. Bewerben '
      + 'Sie sich noch heute für diese Stelle.',
  });
  assert.equal(german.isAffirmativelyNonEnglish, true);
});
