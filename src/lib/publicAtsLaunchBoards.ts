/** Public tenants verified for the first adapter rollout. No read tokens are stored here. */
export const PUBLIC_ATS_LAUNCH_BOARDS = [
  { platform: 'dayforce', slug: 'mydayforce' },
  { platform: 'oracle', slug: 'ehtl.fa.us6.oraclecloud.com::CX' },
  { platform: 'ukg', slug: 'recruiting2.ultipro.com::dre1001dryg::6ca32cd1-ca64-4d8f-82e7-f65b3aaa0e9b' },
  { platform: 'comeet', slug: 'port::59.004' },
  { platform: 'successfactors', slug: 'career5.successfactors.eu::C0001122692P::default' },
  { platform: 'zohorecruit', slug: 'thinkbridge.zohorecruit.in::Careers' },
] as const;
