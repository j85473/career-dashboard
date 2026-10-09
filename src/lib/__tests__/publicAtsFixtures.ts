export const publicAtsTestSlugs: Record<string, string> = {
  dayforce: 'mydayforce', oracle: 'ehtl.fa.us6.oraclecloud.com::CX',
  ukg: 'recruiting2.ultipro.com::dre1001dryg::6ca32cd1-ca64-4d8f-82e7-f65b3aaa0e9b',
  comeet: 'port::59.004', successfactors: 'career5.successfactors.eu::C0001122692P::default',
  zohorecruit: 'thinkbridge.zohorecruit.in::Careers',
  gem: 'example', jobscore: 'example', jazzhr: 'example', manatal: 'example', hirehive: 'example',
  clearcompany: 'adc5441f-f521-a46d-ad4d-ad46a1954fcc',
};
export const ukgOpportunityId = '728fb6e4-c49c-48f8-9099-28eb36d8a552';
export const publicAtsTestFixtures: Record<string, unknown> = {
  gem: [{ id: 123, title: 'Channel Manager', content: '<p>Full description</p>', absolute_url: 'https://jobs.gem.com/example/123', location: { name: 'Austin, TX' } }],
  jobscore: { company_name: 'Example Inc', jobs: [{ id: 'abc', title: 'Channel Manager', description: '<p>Full description</p>', detail_url: 'https://careers.jobscore.com/careers/example/jobs/abc', location: 'Austin, TX' }] },
  manatal: { count: 1, next: null, results: [{ hash: 'ABC123', position_name: 'Channel Manager', description: '<p>Full description</p>', location_display: 'Austin, TX' }] },
  clearcompany: { totalCount: 1, currentPageIndex: 0, results: [{ id: 'posting123', positionTitle: 'Channel Manager', brandName: 'Example Inc', description: '<p>Full description</p>', applyLink: 'https://jobs.clearcompany.com/careers/jobs/posting123/apply', location: 'Austin, TX' }] },
  hirehive: { meta: { page: 1, page_size: 20, total_items: 1, has_next_page: false }, items: [{ id: 'job_abc', title: 'Channel Manager', description: { html: '<p>Full description</p>' }, hosted_url: 'https://example.hirehive.com/channel-manager-abc', location: 'Austin', state_code: 'TX', country: 'US' }] },
  dayforce: [{ Title: 'Channel Manager', CompanyName: 'Dayforce', Description: '<p>Full description</p>',
    JobDetailsUrl: 'https://jobs.dayforcehcm.com/en-US/mydayforce/ALLJOBS/jobs/56234',
    ReferenceNumber: 56234, City: 'Chicago', State: 'IL', Country: 'US', IsVirtualLocation: true }],
  oracle: { items: [{ TotalJobsCount: 1, requisitionList: [{ Id: '19195', Title: 'Channel Manager',
    PrimaryLocation: 'Chicago, IL', ShortDescriptionStr: 'A misleading brief stub' }] }] },
  ukg: { totalCount: 1, opportunities: [{ Id: ukgOpportunityId, Title: 'Channel Manager',
    BriefDescription: 'A misleading brief stub', Locations: [{ LocalizedDescription: 'TX - Remote' }] }] },
  comeet: [{ uid: 'F3.27B', name: 'Channel Manager', company_name: 'Port',
    url_comeet_hosted_page: 'https://www.comeet.com/jobs/port/59.004/channel-manager/F3.27B',
    location: { city: 'Boston', state: 'MA', country: 'US' }, workplace_type: 'Hybrid',
    details: [{ name: 'Responsibilities', value: '<p>Full description</p>' }],
    time_updated: '2026-10-05T12:00:00Z', position_url: 'https://example.invalid/?token=never-persist' }],
  zohorecruit: { code: 'success', info: { page_name: 'Careers' }, data: [{
    id: '40078000018949076', Posting_Title: 'Channel Manager', Job_Description: '<p>Full description</p>',
    Publish: true, Remote_Job: 'Yes', City: 'Austin', State: 'TX', Country: 'US', Date_Opened: '2026-09-28',
  }] },
};
