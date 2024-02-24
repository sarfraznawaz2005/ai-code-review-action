const core = require('@actions/core');
const github = require('@actions/github');
const axios = require('axios');
const nodemailer = require('nodemailer');
const showdown = require('showdown');

const converter = new showdown.Converter({
    omitExtraWLInCodeBlocks: true,
    simplifiedAutoLink: true,
});

async function getPrDiff(prNumber, octokit, repo) {
    const { data: diff } = await octokit.rest.pulls.get({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: prNumber,
        mediaType: { format: 'diff' },
    });

    return diff;
}

// this gets latest code diffs for each file
async function getLatestPushDiff(commits, octokit, repo) {
    let latestCommitsForFiles = {};

    // Step 1: Determine the latest commit for each file
    for (const commit of commits) {
        const { data: commitData } = await octokit.rest.repos.getCommit({
            owner: repo.owner,
            repo: repo.repo,
            ref: commit.id,
        });

        for (const file of commitData.files) {
            // Update the latest commit for the file
            latestCommitsForFiles[file.filename] = commit.id;
        }
    }

    let diffs = '';
    let processedCommits = new Set(); // To avoid processing the same commit multiple times

    // Step 2: Fetch and process diffs only for the latest commits of each file
    for (const [filename, commitId] of Object.entries(latestCommitsForFiles)) {
        if (!processedCommits.has(commitId)) {
            const { data: commitData } = await octokit.rest.repos.getCommit({
                owner: repo.owner,
                repo: repo.repo,
                ref: commitId,
            });

            for (const file of commitData.files) {
                if (file.filename === filename) {
                    diffs += `Commit: ${commitId}\nFile: ${file.filename}\n${file.patch}\n`;
                }
            }

            processedCommits.add(commitId);
        }
    }

    return diffs;
}

async function getPushDiff(commits, octokit, repo) {
    let diffs = '';
    for (const commit of commits) {
        const { data: commitData } = await octokit.rest.repos.getCommit({
            owner: repo.owner,
            repo: repo.repo,
            ref: commit.id,
        });

        diffs += commitData.files.map(file => `Commit: ${commit.id}\nFile: ${file.filename}\n${file.patch}\n`).join('\n');
    }

    return diffs;
}

async function getReview(diff, geminiApiKey, model) {
    const apiUrl = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${geminiApiKey}`;

    // Always start your suggestions with file name(s) including line numbers with each suggestion.

    const prompt = `
    You are developing an automated code review tool for the Engineering department of a technology/software company. 
    Given a code snippet or file, analyze the code's quality and provide suggestions for improvement. Identify common 
    issues such as code smells, anti-patterns, potential bugs, performance bottlenecks, security vulnerabilities, 
    inefficient database queries, frequent or unnecessary I/O operations, or resource-intensive loops, complex or 
    convoluted code structures, excessive code coupling, lack of modularity, poor separation of concerns, architectural 
    inconsistencies, or dependencies that hinder unit testing, or code that is hard to understand and maintain. 
    
    Offer actionable recommendations to address these issues and improve the overall quality of the code. Please start 
    your suggestions with file name(s) including line numbers with each suggestion where possible.
    
    Rules you must follow for your answer:
		- Please don't include files containing sensitive information such as passwords in your review.
		- Instead of showing actual passwords in your review, mask them.
    
    Here is code you need to review: 
    ${diff}
    `;

    try {

        const postData = {
            contents: [
                {
                    role: 'user',
                    parts: [
                        {
                            text: prompt
                        }
                    ]
                }
            ],
            generationConfig: {
                maxOutputTokens: 4096,
                //temperature: 1.0,
                //topP: 0.8,
                //topK: 10
            }
        };

        const response = await axios.post(apiUrl, postData, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        //console.log(response);

        return response?.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? 'Error or no response!';

    } catch (error) {
        console.error('Error:', error);
    }
}

async function commentOnPr(prNumber, explanation, octokit, repo) {
    await octokit.rest.issues.createComment({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: prNumber,
        body: explanation,
        labels: ['code-review'],
    });
}

async function createCodeReviewIssueForPush(body, octokit, repo) {
    // Attempt to fetch the latest issue to use its number for naming. This is not fully reliable for naming conventions.
    const { data: issues } = await octokit.rest.issues.listForRepo({
        owner: repo.owner,
        repo: repo.repo,
        state: 'all', // Consider both open and closed issues
        labels: 'code-review', // Filter by a specific label if you use one
        per_page: 1, // We only need the latest issue
        direction: 'desc', // Ensure we get the latest
    });

    let issueNumber = 1; // Default if no issues are found
    if (issues.length > 0) {
        // Try to extract an issue number from the latest code review issue title
        const match = issues[0].title.match(/Code Review Issue #(\d+)/);
        if (match) {
            issueNumber = parseInt(match[1], 10) + 1; // Increment the extracted number
        }
    }

    // Create the new issue with an incremented title and tag it with "code-review"
    await octokit.rest.issues.create({
        owner: repo.owner,
        repo: repo.repo,
        title: `Code Review Issue #${issueNumber}`,
        body: body,
        labels: ['code-review'], // Tagging the issue with "code-review"
    });
}


async function sendEmail(subject, body, emailConfig) {

    if (body.length <= 10) {
        return;
    }

    if (!emailConfig.host || !emailConfig.to) {
        console.log("No email credentials confirued!");
    }
    else {

        const transporter = nodemailer.createTransport({
            host: emailConfig.host,
            port: emailConfig.port,
            secure: emailConfig.secure, // true for 465, false for other ports
            auth: {
                user: emailConfig.user,
                pass: emailConfig.pass,
            },
            tls: {
                ciphers: 'SSLv3',
                rejectUnauthorized: false
            }
        });

        const mailOptions = {
            from: emailConfig.from,
            to: emailConfig.to,
            bcc: emailConfig.bcc,
            subject: subject,
            html: body,
        };

        await transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.log('Error sending email:', error);
            } else {
                console.log('Email sent: ' + info.response);
            }
        });
    }
}

async function run() {
    try {
        const token = core.getInput('github-token', { required: true });
        const geminiApiKey = core.getInput('gemini-api-key', { required: true });
        const model = core.getInput('model');
        const octokit = github.getOctokit(token);
        const repo = github.context.repo;

        const emailConfig = {
            host: core.getInput('email-host'),
            port: core.getInput('email-port'),
            secure: core.getInput('email-secure') == 'true',
            user: core.getInput('email-user'),
            pass: core.getInput('email-pass'),
            from: core.getInput('email-from'),
            to: core.getInput('email-to'),
            bcc: core.getInput('email-bcc'),
        };

        let subject = '';
        let body = '';
        let userName = '';

        if (github.context.eventName === 'pull_request') {
            const prNumber = github.context.payload.pull_request.number;
            const diff = await getPrDiff(prNumber, octokit, repo);
            const explanation = await getReview(diff, geminiApiKey, model);
            userName = github.context.payload.pull_request.user.login;

            //await commentOnPr(prNumber, explanation, octokit, repo);

            subject = `Code Review: Pull Request #${prNumber} in ${repo.repo.toUpperCase()} By ${userName}`;
            body = explanation;

        } else if (github.context.eventName === 'push') {
            const commits = github.context.payload.commits;
            userName = github.context.payload.pusher.name;
            userName = userName || github.context.payload.pull_request.user.login;

            if (!commits || commits.length === 0) {
                console.log('No commits found in push event.');
                return;
            }

            const diff = await getPushDiff(commits, octokit, repo);
            const explanation = await getReview(diff, geminiApiKey, model);

            //await createCodeReviewIssueForPush(explanation, octokit, repo);

            subject = `Code Review: Push Event in ${repo.repo.toUpperCase()} By ${userName}`;
            body = explanation;

            console.log(`explanation`);
            console.log(explanation);
        }

        if (body && !body.toLowerCase().includes('no response')) {
            body = converter.makeHtml(body).trim();

            if (body) {
                await sendEmail(subject, body, emailConfig);
            }

        }

    } catch (error) {
        core.setFailed(error.message);
    }
}


run();
