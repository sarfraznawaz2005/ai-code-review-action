const core = require('@actions/core');
const github = require('@actions/github');
const axios = require('axios');
const nodemailer = require('nodemailer');
const showdown = require('showdown');

const converter = new showdown.Converter({
    omitExtraWLInCodeBlocks: true,
    simplifiedAutoLink: true,
    strikethrough: true
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

async function getExplanation(diff, geminiApiKey, model) {
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;

    const prompt = `
    Act as a code reviewer with deep knowledge of software development. Always start your suggestions with file name(s) 
    including line numbers with each suggestion. 
    
    Rules you must follow:
    - Only consider code files not images or videos for example.
    - Don't suggest about indentation and readability or spacing issues.
    - Don't suggest about things like adding/removing a comment or "descriptive names".
    
    Here is code: 
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

        return response.data.candidates[0].content.parts[0].text || 'Error or no response!';

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
    });
}

async function sendEmail(subject, body, emailConfig) {

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
            secure: core.getInput('email-secure') === 'true',
            user: core.getInput('email-user'),
            pass: core.getInput('email-pass'),
            from: core.getInput('email-from'),
            to: core.getInput('email-to'),
            bcc: core.getInput('email-bcc'),
        };

        let subject = '';
        let body = '';

        if (github.context.eventName === 'pull_request') {
            const prNumber = github.context.payload.pull_request.number;
            const diff = await getPrDiff(prNumber, octokit, repo);
            const explanation = await getExplanation(diff, geminiApiKey, model);

            await commentOnPr(prNumber, explanation, octokit, repo);

            subject = `Code Review: Pull Request #${prNumber} in ${repo.repo.toUpperCase()}`;
            body = explanation;

        } else if (github.context.eventName === 'push') {
            const commits = github.context.payload.commits;

            if (!commits || commits.length === 0) {
                console.log('No commits found in push event.');
                return;
            }

            const diff = await getPushDiff(commits, octokit, repo);
            const explanation = await getExplanation(diff, geminiApiKey, model);

            subject = `Code Review: Push Event in ${repo.repo.toUpperCase()}`;
            body = explanation;
            console.log(`explanation`);
            console.log(explanation);
        }

        if (body) {
            body = converter.makeHtml(body);

            await sendEmail(subject, body, emailConfig);
        }

    } catch (error) {
        core.setFailed(error.message);
    }
}


run();
