FROM quay.io/lyfe00011/md:beta
RUN git clone https://github.com/lyfe00011/levanter.git /root/LyFE/
WORKDIR /root/LyFE/
RUN yarn install
COPY plugins/ /root/LyFE/plugins/
ENV BOT_LANG=en
CMD ["npm", "start"]

