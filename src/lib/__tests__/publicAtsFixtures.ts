export const publicAtsTestSlugs: Record<string, string> = {
  dayforce: 'mydayforce', oracle: 'ehtl.fa.us6.oraclecloud.com::CX',
  ukg: 'recruiting2.ultipro.com::dre1001dryg::6ca32cd1-ca64-4d8f-82e7-f65b3aaa0e9b',
  comeet: 'port::59.004', successfactors: 'career5.successfactors.eu::C0001122692P::default',
  zohorecruit: 'thinkbridge.zohorecruit.in::Careers',
};
export const ukgOpportunityId = '728fb6e4-c49c-48f8-9099-28eb36d8a552';
export const publicAtsTestFixtures: Record<string, unknown> = {
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
