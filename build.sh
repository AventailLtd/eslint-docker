#
IMAGE="dblaci/estlint-docker:20260528"
docker build -t $IMAGE .
docker push $IMAGE
