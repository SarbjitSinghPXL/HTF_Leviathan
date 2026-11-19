
pipeline {
    agent {
        label 'linux && podman'
    }

    options {
        disableConcurrentBuilds()
        timeout(time: 30, unit: 'MINUTES')
    }

    stages {
        stage('Build frontend image') {
            steps {
                sh '''
                    set -eu

                    podman --cgroup-manager=cgroupfs build \
                      --platform linux/amd64 \
                      -f frontend/Dockerfile \
                      -t localhost/htf-leviathan-frontend:test \
                      ./frontend

                    podman --cgroup-manager=cgroupfs image inspect \
                      localhost/htf-leviathan-frontend:test \
                      --format '{{.Os}}/{{.Architecture}}'
                '''
            }
        }

        stage('Build API image') {
            steps {
                sh '''
                    set -eu

                    podman --cgroup-manager=cgroupfs build \
                      --platform linux/amd64 \
                      -f api/Dockerfile \
                      -t localhost/htf-leviathan-api:test \
                      ./api

                    podman --cgroup-manager=cgroupfs image inspect \
                      localhost/htf-leviathan-api:test \
                      --format '{{.Os}}/{{.Architecture}}'
                '''
            }
        }
    }
}
