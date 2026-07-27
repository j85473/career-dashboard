import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';

const prisma = new PrismaClient();
const ELIGIBLE_STATUSES = ['inbox', 'pending_af'];

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'fetch') {
    const limit = parseInt(args[1], 10) || 50;
    
    const resumePath = path.join(process.cwd(), 'data', 'resumes', 'core_resume.txt');
    let coreResume = { text: '' };
    if (fs.existsSync(resumePath)) {
      coreResume.text = fs.readFileSync(resumePath, 'utf8');
    } else {
      console.error('No resume found at ' + resumePath);
      process.exit(1);
    }

    const jobs = await prisma.job.findMany({
      where: {
        status: { in: ELIGIBLE_STATUSES },
        scoringStatus: 'scored',
        aimFitScore: null,
      },
      take: limit,
      orderBy: { updatedAt: 'asc' },
      select: {
        id: true,
        title: true,
        company: true,
        description: true,
        location: true,
        status: true,
      }
    });

    // Chunk into 5s
    const chunks = [];
    for (let i = 0; i < jobs.length; i += 5) {
      chunks.push(jobs.slice(i, i + 5));
    }

    const output = {
      resume: coreResume.text,
      chunks
    };

    console.log(JSON.stringify(output));
    
  } else if (command === 'fetch-wildcard') {
    const limit = parseInt(args[1], 10) || 50;

    const wildcardProfileEntity = await prisma.wildcardProfile.findFirst();
    const profileText = wildcardProfileEntity?.profileText || '- No wildcard profile established.';

    const jobs = await prisma.job.findMany({
      where: {
        luckyStatus: 'pending',
        scoringStatus: 'scored',
      },
      take: limit,
      orderBy: { updatedAt: 'asc' },
      select: {
        id: true,
        title: true,
        company: true,
        description: true,
        location: true,
        status: true,
      }
    });

    const chunks = [];
    for (let i = 0; i < jobs.length; i += 5) {
      chunks.push(jobs.slice(i, i + 5));
    }

    const output = {
      wildcardProfile: profileText,
      chunks
    };

    console.log(JSON.stringify(output));

  } else if (command === 'save') {
    const jsonStr = args[1];
    let data;
    try {
      data = JSON.parse(jsonStr);
    } catch (e) {
      const fileContent = fs.readFileSync(jsonStr, 'utf8');
      data = JSON.parse(fileContent);
    }

    const jobScores = data.jobScores || data;
    
    let scoresProcessed = 0;
    for (const score of jobScores) {
      // Determine final status
      const passesExperience = score.experienceFitScore >= 75;
      const passesAim = score.aimFitScore >= 75;
      const passes = passesExperience && passesAim;
      
      const newStatus = passes ? 'inbox' : 'dismissed';
      const newLuckyStatus = score.experienceFitScore >= 85 ? 'pending' : 'none';
      const passReason = passes ? null : (passesExperience ? score.aimFitReason : score.experienceFitReason);

      await prisma.$transaction(async (tx) => {
        const result = await tx.job.updateMany({
          where: {
            id: score.id,
            status: { in: ELIGIBLE_STATUSES },
            aimFitScore: null,
          },
          data: {
            status: newStatus,
            luckyStatus: newLuckyStatus,
            aimFitScore: score.aimFitScore,
            passReason: passReason,
            reqFitScore: score.experienceFitScore,
            reqFitRationale: score.experienceFitReason,
            travelScore: score.travelScore,
            scoringStatus: 'scored',
            experienceStatus: 'scored',
            compensation: score.compensation,
          },
        });
        
        if (result.count === 1) {
          await tx.jobScoreEvent.create({
            data: {
              jobId: score.id,
              evaluationType: 'standard',
              model: 'native-chat-evaluator',
              promptVersion: 'native-v1',
              requestId: 'native',
              aimFitScore: score.aimFitScore,
              experienceFitScore: score.experienceFitScore,
              travelScore: score.travelScore,
              domainMatch: score.domain_match === undefined ? true : score.domain_match,
              requiredDomain: score.required_domain || '',
              candidateDomain: score.candidate_domain || '',
              requiredYearsInDomain: score.required_years_in_domain || null,
              candidateYearsInDomain: score.candidate_years_in_domain || null,
              passed: passes,
              aimReason: score.aimFitReason,
              experienceReason: score.experienceFitReason,
            }
          });
        }
      }, { timeout: 120000 });
      scoresProcessed++;
    }
    console.log(`Successfully saved ${scoresProcessed} job scores.`);

  } else if (command === 'save-wildcard') {
    const jsonStr = args[1];
    let data;
    try {
      data = JSON.parse(jsonStr);
    } catch (e) {
      const fileContent = fs.readFileSync(jsonStr, 'utf8');
      data = JSON.parse(fileContent);
    }

    const jobScores = data.jobScores || data;
    let scoresProcessed = 0;
    for (const score of jobScores) {
      const passes = score.vibeFitScore >= 85;
      const newLuckyStatus = passes ? 'inbox' : 'dismissed';

      await prisma.$transaction(async (tx) => {
        const result = await tx.job.updateMany({
          where: {
            id: score.id,
            luckyStatus: 'pending',
          },
          data: {
            luckyStatus: newLuckyStatus,
            luckyAimFitScore: score.vibeFitScore,
            luckyPassReason: passes
              ? `Vibe Fit: ${score.vibeFitReason}`
              : `[Wildcard Reject] Vibe Fit: ${score.vibeFitReason}`,
            compensation: score.compensation,
          },
        });

        if (result.count === 1) {
          await tx.jobScoreEvent.create({
            data: {
              jobId: score.id,
              evaluationType: 'wildcard',
              model: 'native-chat-evaluator',
              promptVersion: 'native-v1',
              requestId: 'native',
              aimFitScore: score.vibeFitScore,
              passed: passes,
              aimReason: score.vibeFitReason,
            }
          });
        }
      }, { timeout: 120000 });
      scoresProcessed++;
    }
    console.log(`Successfully saved ${scoresProcessed} wildcard job scores.`);
  } else if (command === 'fetch-inbox-audit') {
    const limit = parseInt(args[1], 10) || 50;
    
    const resumePath = path.join(process.cwd(), 'data', 'resumes', 'core_resume.txt');
    let coreResume = { text: '' };
    if (fs.existsSync(resumePath)) {
      coreResume.text = fs.readFileSync(resumePath, 'utf8');
    } else {
      console.error('No resume found at ' + resumePath);
      process.exit(1);
    }

    const jobs = await prisma.job.findMany({
      where: {
        status: 'inbox_audit_pending',
      },
      take: limit,
      orderBy: { updatedAt: 'asc' },
      select: {
        id: true,
        title: true,
        company: true,
        description: true,
        location: true,
        status: true,
      }
    });

    const chunks = [];
    for (let i = 0; i < jobs.length; i += 5) {
      chunks.push(jobs.slice(i, i + 5));
    }

    const output = {
      resume: coreResume.text,
      chunks
    };

    console.log(JSON.stringify(output));
  } else if (command === 'save-inbox-audit') {
    const jsonStr = args[1];
    let data;
    try {
      data = JSON.parse(jsonStr);
    } catch (e) {
      const fileContent = fs.readFileSync(jsonStr, 'utf8');
      data = JSON.parse(fileContent);
    }

    const jobScores = data.jobScores || data;
    let scoresProcessed = 0;
    for (const score of jobScores) {
      const passesExperience = score.experienceFitScore >= 80;
      const passesAim = score.aimFitScore >= 80;
      const passes = passesExperience && passesAim;
      
      const newStatus = passes ? 'inbox' : 'dismissed';
      const passReason = passes ? null : (passesExperience ? score.aimFitReason : score.experienceFitReason);

      await prisma.$transaction(async (tx) => {
        const result = await tx.job.updateMany({
          where: {
            id: score.id,
            status: 'inbox_audit_pending',
          },
          data: {
            status: newStatus,
            aimFitScore: score.aimFitScore,
            passReason: passReason,
            reqFitScore: score.experienceFitScore,
            reqFitRationale: score.experienceFitReason,
            travelScore: score.travelScore,
            compensation: score.compensation,
          },
        });
        
        if (result.count === 1) {
          await tx.jobScoreEvent.create({
            data: {
              jobId: score.id,
              evaluationType: 'inbox_audit',
              model: 'native-chat-evaluator',
              promptVersion: 'native-v2-audit',
              requestId: 'native',
              aimFitScore: score.aimFitScore,
              experienceFitScore: score.experienceFitScore,
              travelScore: score.travelScore,
              passed: passes,
              aimReason: score.aimFitReason,
              experienceReason: score.experienceFitReason,
            }
          });
        }
      }, { timeout: 120000 });
      scoresProcessed++;
    }
    console.log(`Successfully audited and saved ${scoresProcessed} job scores.`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
