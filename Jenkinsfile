
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
        stage('Push images to private registry') {
            steps {
                sh '''
                    set -eu

                    REGISTRY="10.43.189.172:5000"
                    AUTHFILE="/home/jenkins-builder/.config/containers/auth.json"

                    podman --cgroup-manager=cgroupfs tag \
                    localhost/htf-leviathan-frontend:test \
                    "$REGISTRY/htf-leviathan-frontend:test"

                    podman --cgroup-manager=cgroupfs tag \
                    localhost/htf-leviathan-api:test \
                    "$REGISTRY/htf-leviathan-api:test"

                    podman --cgroup-manager=cgroupfs push \
                    --authfile "$AUTHFILE" \
                    "$REGISTRY/htf-leviathan-frontend:test"

                    podman --cgroup-manager=cgroupfs push \
                    --authfile "$AUTHFILE" \
                    "$REGISTRY/htf-leviathan-api:test"
                '''
            }
        }
    }
}
