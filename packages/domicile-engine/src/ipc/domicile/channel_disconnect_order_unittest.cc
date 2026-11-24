// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/functional/callback_helpers.h"
#include "base/location.h"
#include "base/memory/scoped_refptr.h"
#include "base/message_loop/message_pump_type.h"
#include "base/run_loop.h"
#include "base/strings/string_number_conversions.h"
#include "base/synchronization/lock.h"
#include "base/task/bind_post_task.h"
#include "base/task/single_thread_task_runner.h"
#include "base/test/bind.h"
#include "base/test/run_until.h"
#include "base/test/task_environment.h"
#include "base/thread_annotations.h"
#include "base/threading/thread.h"
#include "base/time/time.h"
#include "ipc/ipc.mojom.h"
#include "ipc/ipc_channel.h"
#include "ipc/ipc_mojo_bootstrap.h"
#include "mojo/public/cpp/bindings/associated_receiver.h"
#include "mojo/public/cpp/bindings/associated_remote.h"
#include "mojo/public/cpp/bindings/pending_associated_receiver.h"
#include "mojo/public/cpp/bindings/pending_associated_remote.h"
#include "mojo/public/cpp/system/message_pipe.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace {

// Holds what is posted to it until Release(), then posts it to `target` in
// order. A channel's proxy task runner whose queue runs after the endpoint's
// own, as a renderer's IPC queue can run after a frame's.
class HeldTaskRunner : public base::SingleThreadTaskRunner {
 public:
  explicit HeldTaskRunner(scoped_refptr<base::SingleThreadTaskRunner> target)
      : target_(std::move(target)) {}

  bool PostDelayedTask(const base::Location& from_here,
                       base::OnceClosure task,
                       base::TimeDelta delay) override {
    {
      base::AutoLock lock(lock_);
      held_.push_back(std::move(task));
    }
    // Wakes the target so a RunUntil() on it sees the new count.
    return target_->PostTask(FROM_HERE, base::DoNothing());
  }

  bool PostNonNestableDelayedTask(const base::Location& from_here,
                                  base::OnceClosure task,
                                  base::TimeDelta delay) override {
    return PostDelayedTask(from_here, std::move(task), delay);
  }

  bool RunsTasksInCurrentSequence() const override {
    return target_->RunsTasksInCurrentSequence();
  }

  size_t held() const {
    base::AutoLock lock(lock_);
    return held_.size();
  }

  void Release() {
    std::vector<base::OnceClosure> held;
    {
      base::AutoLock lock(lock_);
      held.swap(held_);
    }
    for (base::OnceClosure& task : held) {
      target_->PostTask(FROM_HERE, std::move(task));
    }
  }

 private:
  ~HeldTaskRunner() override = default;

  const scoped_refptr<base::SingleThreadTaskRunner> target_;
  mutable base::Lock lock_;
  std::vector<base::OnceClosure> held_ GUARDED_BY(lock_);
};

// Records the calls and the disconnect an IPC::mojom::Channel receives, in
// order, and runs `on_disconnect` after the disconnect.
class ChannelRecorder : public IPC::mojom::Channel {
 public:
  ChannelRecorder(mojo::PendingAssociatedReceiver<IPC::mojom::Channel> pending,
                  scoped_refptr<base::SequencedTaskRunner> task_runner,
                  base::OnceClosure on_disconnect)
      : receiver_(this, std::move(pending), std::move(task_runner)),
        on_disconnect_(std::move(on_disconnect)) {
    receiver_.set_disconnect_handler(base::BindOnce(
        &ChannelRecorder::OnDisconnect, base::Unretained(this)));
  }

  void SetPeerPid(int32_t pid) override {
    events_.push_back("SetPeerPid " + base::NumberToString(pid));
  }

  void GetAssociatedInterface(
      mojo::GenericPendingAssociatedReceiver receiver) override {
    events_.push_back("GetAssociatedInterface");
  }

  bool disconnected() const { return disconnected_; }
  const std::vector<std::string>& events() const { return events_; }

 private:
  void OnDisconnect() {
    disconnected_ = true;
    events_.push_back("disconnect");
    std::move(on_disconnect_).Run();
  }

  mojo::AssociatedReceiver<IPC::mojom::Channel> receiver_;
  base::OnceClosure on_disconnect_;
  bool disconnected_ = false;
  std::vector<std::string> events_;
};

// Both ends of an IPC channel, read and written on `io` as a real channel's
// are, with the server's proxy task runner held.
class ChannelDisconnectOrderTest : public testing::Test {
 protected:
  ChannelDisconnectOrderTest() : io_("io") {
    io_.StartWithOptions(base::Thread::Options(base::MessagePumpType::IO, 0));
    held_ = base::MakeRefCounted<HeldTaskRunner>(
        task_environment_.GetMainThreadTaskRunner());
  }

  ~ChannelDisconnectOrderTest() override {
    held_->Release();
    base::RunLoop().RunUntilIdle();
    OnIo(base::BindOnce(
        [](std::unique_ptr<IPC::MojoBootstrap> server,
           std::unique_ptr<IPC::MojoBootstrap> client) {},
        std::move(server_), std::move(client_)));
    io_.Stop();
  }

  // Connects both ends on `io` and starts them receiving.
  void Connect(
      mojo::PendingAssociatedReceiver<IPC::mojom::Channel>* server_receiver,
      mojo::PendingAssociatedRemote<IPC::mojom::Channel>* client_sender) {
    mojo::MessagePipe pipe;
    server_ = IPC::MojoBootstrap::Create(
        std::move(pipe.handle0), IPC::Channel::MODE_SERVER, io_.task_runner(),
        held_);
    client_ = IPC::MojoBootstrap::Create(
        std::move(pipe.handle1), IPC::Channel::MODE_CLIENT, io_.task_runner(),
        task_environment_.GetMainThreadTaskRunner());
    OnIo(base::BindOnce(
        [](IPC::MojoBootstrap* server, IPC::MojoBootstrap* client,
           mojo::PendingAssociatedReceiver<IPC::mojom::Channel>*
               server_receiver,
           mojo::PendingAssociatedRemote<IPC::mojom::Channel>* client_sender) {
          mojo::PendingAssociatedRemote<IPC::mojom::Channel> server_sender;
          mojo::PendingAssociatedReceiver<IPC::mojom::Channel> client_receiver;
          server->Connect(&server_sender, server_receiver);
          client->Connect(client_sender, &client_receiver);
        },
        server_.get(), client_.get(), server_receiver, client_sender));
  }

  void StartReceiving() {
    OnIo(base::BindOnce(
        [](IPC::MojoBootstrap* server, IPC::MojoBootstrap* client) {
          server->StartReceiving();
          client->StartReceiving();
        },
        server_.get(), client_.get()));
  }

  base::test::TaskEnvironment task_environment_;
  base::Thread io_;
  scoped_refptr<HeldTaskRunner> held_;

 private:
  void OnIo(base::OnceClosure task) {
    base::RunLoop run_loop;
    io_.task_runner()->PostTaskAndReply(FROM_HERE, std::move(task),
                                        run_loop.QuitClosure());
    run_loop.Run();
  }

  std::unique_ptr<IPC::MojoBootstrap> server_;
  std::unique_ptr<IPC::MojoBootstrap> client_;
};

// The renderer's blink.mojom.Widget receiver: bound to a frame's task runner,
// its messages queued on the channel's proxy task runner. The browser calls it
// and closes its end; the call must arrive before the disconnect.
TEST_F(ChannelDisconnectOrderTest, ACallArrivesBeforeTheDisconnectAfterIt) {
  mojo::PendingAssociatedReceiver<IPC::mojom::Channel> server_receiver;
  mojo::PendingAssociatedRemote<IPC::mojom::Channel> client_sender;
  Connect(&server_receiver, &client_sender);

  ChannelRecorder recorder(std::move(server_receiver),
                           task_environment_.GetMainThreadTaskRunner(),
                           base::DoNothing());
  mojo::AssociatedRemote<IPC::mojom::Channel> sender(std::move(client_sender));
  StartReceiving();

  sender->SetPeerPid(42);
  sender.reset();

  // The call is queued on the held proxy task runner. The disconnect is
  // either queued behind it or, out of order, already delivered.
  ASSERT_TRUE(base::test::RunUntil(
      [&] { return recorder.disconnected() || held_->held() == 2; }));
  held_->Release();
  ASSERT_TRUE(base::test::RunUntil([&] { return recorder.disconnected(); }));

  EXPECT_EQ(recorder.events(),
            (std::vector<std::string>{"SetPeerPid 42", "disconnect"}));
}

// An endpoint bound to another thread hears the disconnect there, after it
// passes through the proxy task runner.
TEST_F(ChannelDisconnectOrderTest, AnEndpointOnAnotherThreadIsDisconnected) {
  mojo::PendingAssociatedReceiver<IPC::mojom::Channel> server_receiver;
  mojo::PendingAssociatedRemote<IPC::mojom::Channel> client_sender;
  Connect(&server_receiver, &client_sender);

  base::Thread other("other");
  other.Start();
  base::RunLoop disconnected;
  // Made here: a RunLoop's QuitClosure() must be taken on its own thread.
  base::OnceClosure on_disconnect =
      base::BindPostTask(task_environment_.GetMainThreadTaskRunner(),
                         disconnected.QuitClosure());
  std::unique_ptr<ChannelRecorder> recorder;
  {
    base::RunLoop bound;
    other.task_runner()->PostTaskAndReply(
        FROM_HERE, base::BindLambdaForTesting([&] {
          recorder = std::make_unique<ChannelRecorder>(
              std::move(server_receiver), other.task_runner(),
              std::move(on_disconnect));
        }),
        bound.QuitClosure());
    bound.Run();
  }
  mojo::AssociatedRemote<IPC::mojom::Channel> sender(std::move(client_sender));
  StartReceiving();

  sender.reset();
  ASSERT_TRUE(base::test::RunUntil([&] { return held_->held() == 1; }));
  held_->Release();
  disconnected.Run();

  other.task_runner()->DeleteSoon(FROM_HERE, std::move(recorder));
  other.Stop();
}

}  // namespace
