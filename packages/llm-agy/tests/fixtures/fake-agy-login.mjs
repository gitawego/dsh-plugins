if (process.env.FAKE_AGY_LOGIN_NO_URL === '1') {
    process.stderr.write('no login available\n')
    process.exit(4)
}

process.stdout.write('Open this link in a browser to log in with Google:\n\n')
process.stdout.write('  https://accounts.google.com/o/oauth2/auth?client_id=fake&state=xyz\n\n')
process.stdout.write('Then paste the authorization code, or the full URL of the page you land on, and press Enter:\n')

process.stdin.setEncoding('utf8')
let buffer = ''
process.stdin.on('data', (chunk) => {
    buffer += chunk
    const newline = buffer.indexOf('\n')
    if (newline === -1) return
    const answer = buffer.slice(0, newline).trim()
    if (answer.startsWith('bad')) {
        process.stderr.write('authorization rejected\n')
        process.exit(2)
    }
    const code = answer.startsWith('http') ? new URL(answer).searchParams.get('code') : answer
    if (code !== 'good') {
        process.stderr.write(`unexpected code ${String(code)}\n`)
        process.exit(3)
    }
    process.stdout.write('Successfully authenticated.\n')
    process.exit(0)
})
