#
IMAGE="dblaci/estlint-docker:20260530"
docker build -t $IMAGE .
docker push $IMAGE
