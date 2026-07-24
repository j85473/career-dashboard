import { PrismaClient } from '@prisma/client';
import { generateV4Fingerprint } from '../lib/jobIngestion';

const prisma = new PrismaClient();

async function run() {
  const title = "Key Channel Executive";
  const company = "Beckman Coulter Diagnostics";
  const url = "https://careers.danaher.com/global/en/beckman-coulter-diagnostics"; // placeholder
  const description = `Bring more to life.

Are you ready to accelerate your potential and make a real difference within life sciences, diagnostics and biotechnology?

At Beckman Coulter Diagnostics, one of Danaher’s 15+ operating companies, our work saves lives—and we’re all united by a shared commitment to innovate for tangible impact.

You’ll thrive in a culture of belonging where you and your unique viewpoint matter. And by harnessing Danaher’s system of continuous improvement, you help turn ideas into impact – innovating at the speed of life.

As a global leader in clinical diagnostics, Beckman Coulter Diagnostics has challenged convention to elevate the diagnostic laboratory’s role in improving patient health for more than 90 years. Our diagnostic solutions are used in routine and complex clinical testing, and are used in hospitals, reference and research laboratories, and physician offices around the world. Every hour around the world, more than one million tests are run on Beckman Coulter Diagnostics systems, impacting 1.2 billion patients and more than three million clinicians per year. From uncovering the next clinical breakthrough, to rapid and reliable sample analysis, to more rigorous decision making—we are enabling clinicians to deliver the best possible care to their patients with improved efficiency, clinical confidence, adaptive collaboration, and accelerated intelligence. Learn about the Danaher Business System which makes everything possible.

The Key Channel Executive for Beckman Coulter Diagnostics is responsible for owning and developing an account strategy in coordination with our distribution partners in the non-acute market. You will uphold current knowledge of the customers’ business, financial and technical needs as well as strategically position our products through tactical sales techniques to put Beckman Coulter in a position to win.  

This position is part of North America Commercial Operations and will be fully remote in field, as part of the Central Region Channel Sales Team, with 60% travel. This specific geography covers the Chicagoland Area, Wisconsin and Minnesota. At Beckman Coulter, our vision is to relentlessly reimagine healthcare, one diagnosis at a time.  

In this role, you will have the opportunity to: 
Partner with our distributors and hospital market Beckman Coulter Dx team to call on assigned accounts and prioritize sales activities within those accounts (existing and competitive) to position Beckman Coulter products with customer’s needs; Promote install base revenue growth via margin and test menu expansion; Involve product experts in the development of account strategy, and throughout the sales process. 
Utilize key influencers for developing and closing sales through distribution in physician offices, regional reference, student health centers, urgent care and community and public health laboratories.   
Through solid market and competitor knowledge, develop and execute creative strategies to influence the decision criteria and utilize winning tactics to close the sale; Own and manage the preparation & execution of business reviews, account plans, regional meetings and product shows. 
Effectively link Beckman Coulter’s solutions to the customers’ technical, financial and business needs.  
Implement the sales plan designed to achieve established sales and financial goals; Responsible for contracting and pricing strategy for territory Physician’s Office Laboratory customers. 

The essential requirements for the job include:  
Bachelor’s degree required preferably in science or business with 2-3 years’ sales experience preferably within distribution, hospital or laboratory setting. 
Strong relationship building skills with distributor sales and management partners to effectively collaborate and coordinate resources.  
Solid understanding of tactical sales skills (prospecting, qualifying, closing, and growing existing customers) strongly preferred in laboratory diagnostics; Proactive approach examining, diagnosing and prescribing strategic business solutions to meet objectives. 
Strong communication and presentation skills; demonstrated ability to conduct a technical presentation and be able to articulate clearly, concisely and accurately throughout.  
Highly organized, with strong and disciplined program and sales management skills; manages distributor partners, works diligently within the sales cycle activities, prepares for and delivers business reviews effectively (with distributors, customers and internally); Excellent time and territory management habits. 

It would be a plus if you also possess previous experience in: 
Working knowledge of laboratory workflow, workload demands and system needs in a POL laboratory. 

At Beckman Coulter Diagnostics we believe in designing a better, more sustainable workforce. We recognize the benefits of flexible, remote working arrangements for eligible roles and are committed to providing enriching careers, no matter the work arrangement. This position is eligible for a remote work arrangement in which you can work remotely from your home. Additional information about this remote work arrangement will be provided by your interview team. Explore the flexibility and challenge that working for Beckman Coulter Diagnostics can provide. 

The salary range for this role is $95,000 - $110,000. This role is also eligible for Sales Incentive Compensation (SIC). The total target compensation at plan (base + SIC) is $165,000 – $180,000 annually. Actual SIC earnings may exceed or fall below the target based on individual sales performance. This is the range that we in good faith believe is the range of possible compensation for this role at the time of this posting. This range may be modified in the future.`;

  const fingerprint = generateV4Fingerprint(title, company, 'unknown');

  let newJob = await prisma.job.findFirst({ where: { fingerprint } });
  if (!newJob) {
    newJob = await prisma.job.create({
      data: {
        title,
        company,
        url,
        canonicalUrl: url,
        fingerprint,
        description,
        source: 'Chat Drop',
        postedAt: new Date(),
        status: 'pending_af',
        scoringStatus: 'scored',
        experienceStatus: 'scored',
        contextBatched: false,
        tailoringStaged: true,
      }
    });
    console.log('Inserted job with ID:', newJob.id);
  } else {
    console.log('Job already exists with ID:', newJob.id);
    await prisma.job.update({
      where: { id: newJob.id },
      data: { tailoringStaged: true, description }
    });
  }
}

run().catch(console.error).finally(() => prisma.$disconnect());
