
pipeline {
    agent {
        label 'windows && docker'
    }

    options {
        disableConcurrentBuilds()
        timeout(time: 20, unit: 'MINUTES')
    }

    stages {
        stage('Build frontend image') {
            steps {
                powershell '''
                    docker build `
                      --platform linux/amd64 `
                      -f frontend/Dockerfile `
                      -t htf-leviathan-frontend:test `
                      ./frontend

                    if ($LASTEXITCODE -ne 0) {
                        throw "Frontend Docker build mislukt"
                    }

                    docker image inspect htf-leviathan-frontend:test `
                      --format "{{.Os}}/{{.Architecture}}"

                    if ($LASTEXITCODE -ne 0) {
                        throw "Docker image inspect mislukt"
                    }
                '''
            }
        }
        stage('Build API image') {
            steps {
                powershell '''
                    docker build `
                    --platform linux/amd64 `
                    -f api/Dockerfile `
                    -t htf-leviathan-api:test `
                    ./api

                    if ($LASTEXITCODE -ne 0) {
                        throw "API Docker build mislukt"
                    }

                    docker image inspect htf-leviathan-api:test `
                    --format "{{.Os}}/{{.Architecture}}"

                    if ($LASTEXITCODE -ne 0) {
                        throw "Docker image inspect mislukt"
                    }
                '''
            }
        }
        stage('Controleer GHCR login') {
            steps {
                withCredentials([
                    usernamePassword(
                        credentialsId: 'github-ghcr',
                        usernameVariable: 'GHCR_USER',
                        passwordVariable: 'GHCR_TOKEN'
                    )
                ]) {
                    powershell '''
                        $ErrorActionPreference = "Stop"

                        $env:DOCKER_CONFIG = Join-Path $env:TEMP ("jenkins-ghcr-" + $env:BUILD_NUMBER)
                        New-Item -ItemType Directory -Force -Path $env:DOCKER_CONFIG | Out-Null

                        try {
                            $process = New-Object System.Diagnostics.Process
                            $process.StartInfo.FileName = "docker.exe"
                            $process.StartInfo.Arguments = "login ghcr.io --username $env:GHCR_USER --password-stdin"
                            $process.StartInfo.UseShellExecute = $false
                            $process.StartInfo.RedirectStandardInput = $true
                            $process.StartInfo.RedirectStandardOutput = $true
                            $process.StartInfo.RedirectStandardError = $true

                            $process.StartInfo.StandardInputEncoding = New-Object System.Text.UTF8Encoding($false)

                            [void]$process.Start()
                            $process.StandardInput.WriteLine($env:GHCR_TOKEN)
                            $process.StandardInput.Close()

                            $output = $process.StandardOutput.ReadToEnd()
                            $errors = $process.StandardError.ReadToEnd()
                            $process.WaitForExit()

                            if ($process.ExitCode -ne 0) {
                                throw "GHCR login mislukt (exitcode $($process.ExitCode))"
                            }

                            Write-Host "GHCR login geslaagd!"
                        }
                        finally {
                            Remove-Item $env:DOCKER_CONFIG -Recurse -Force -ErrorAction SilentlyContinue
                        }
                    '''
                }
            }
        }
    }
}
